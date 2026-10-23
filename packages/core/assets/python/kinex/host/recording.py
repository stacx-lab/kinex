"""Passive, typed topic recording. World time controls sampling, never progress."""
import asyncio
import json
from pathlib import Path
import sys
import time

from kinex.communication import Subscription, communication


class Recording:
    def __init__(self, io, directory, operations, rate):
        self.io, self.directory = io, Path(directory)
        self.operations, self.period = operations, max(1, round(1e9 / rate))
        self.tasks, self.streams = [], []
        self.counts, self.last = {}, {}
        self.samples = self.skipped = self.frames = 0
        self.error = None
        self.writer = self.index = None
        self.started = self.ended = None
        self.closed = False
        self.wall, self.monotonic = time.time_ns(), time.monotonic_ns()

    def start(self):
        import rosbag2_py
        from rosbag2_py._storage import QoS
        self.directory.mkdir(parents=True, exist_ok=True)
        self.writer = rosbag2_py.SequentialWriter()
        self.writer.open(rosbag2_py.StorageOptions(uri=str(self.directory / "bag"), storage_id="sqlite3"),
                         rosbag2_py.ConverterOptions("cdr", "cdr"))
        self.index = (self.directory / "samples.jsonl").open("w", buffering=1)
        # Preserve the time and frame authorities needed to interpret observations.
        catalog = dict(self.io.catalog)
        catalog["_frames.dynamic"] = {
            "transport": "topic", "direction": "output", "endpoint": "/tf",
            "type": "tf2_msgs/msg/TFMessage", "qos": {"depth": 64, "durability": "transient_local"}}
        catalog["_frames.static"] = {**catalog["_frames.dynamic"], "endpoint": "/tf_static",
                                     "qos": {"depth": 64, "durability": "transient_local"}}
        self.io.catalog = catalog
        selected = list(dict.fromkeys([*self.operations, "_frames.dynamic", "_frames.static",
            *[name for name, op in catalog.items() if op["type"] == "rosgraph_msgs/msg/Clock"]]))
        topics = {}
        for name in selected:
            op = self.io.operation(name, "topic")
            if op["endpoint"] in topics:
                if topics[op["endpoint"]] != op["type"]:
                    raise ValueError("one topic cannot have multiple recording types")
                continue
            topics[op["endpoint"]] = op["type"]
            policy = op.get("qos", {})
            offered = QoS(policy.get("depth", 1))
            if policy.get("reliability") == "best_effort":
                offered.best_effort()
            else:
                offered.reliable()
            if policy.get("durability") == "transient_local":
                offered.transient_local()
            else:
                offered.durability_volatile()
            self.writer.create_topic(rosbag2_py.TopicMetadata(
                id=len(topics), name=op["endpoint"], type=op["type"], serialization_format="cdr",
                offered_qos_profiles=[offered]))
            stream = Subscription(self.io, op, 64)
            self.io.subscriptions.append(stream)
            self.streams.append(stream)
            self.counts[name] = 0
            self.tasks.append(asyncio.create_task(self.consume(name, op, stream)))
        (self.directory / "operations.json").write_text(
            json.dumps({name: catalog[name] for name in selected}, indent=2) + "\n")

    async def consume(self, name, op, stream):
        from rclpy.serialization import serialize_message
        try:
            while True:
                message = await stream.next()
                # Startup can receive retained calibration before the first clock.
                # Wait only for transport; do not request world advancement.
                while self.io.world_stamp is None:
                    await asyncio.sleep(.01)
                stamp, epoch = self.io.world_stamp, self.io.world_epoch
                previous = self.last.get(name)
                if name in self.operations and op["direction"] == "output" and op["type"] != "rosgraph_msgs/msg/Clock":
                    if previous is not None and previous[0] == epoch and stamp - previous[1] < self.period:
                        self.skipped += 1
                        continue
                self.last[name] = (epoch, stamp)
                received = self.wall + time.monotonic_ns() - self.monotonic
                # Bag receive time is monotonic across world resets; original ROS
                # stamps and the explicit epoch/world-time index retain simulation time.
                self.writer.write(op["endpoint"], serialize_message(message), received)
                header = getattr(message, "header", None)
                acquisition_stamp = header.stamp if header else getattr(message, "stamp", None)
                acquisition = (acquisition_stamp.sec * 1_000_000_000 + acquisition_stamp.nanosec) if acquisition_stamp is not None else None
                self.index.write(json.dumps({
                    "operation": name, "topic": op["endpoint"], "type": op["type"],
                    "epoch": epoch, "world_ns": stamp, "received_ns": received,
                    "source_ns": acquisition,
                    **({"frame_id": header.frame_id} if header else {}),
                }) + "\n")
                self.counts[name] += 1
                if name in self.operations:
                    self.samples += 1
                    self.frames += int(op["type"] in ("sensor_msgs/msg/Image", "sensor_msgs/msg/CompressedImage"))
                    self.started = stamp if self.started is None else self.started
                    self.ended = stamp
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.error = f"{name}: {error}"

    def facts(self):
        return {
            "status": "error" if self.error else "stopped" if self.closed else "recording",
            "bag": str(self.directory / "bag"), "timestamps": str(self.directory / "samples.jsonl"),
            "samples": self.samples, "frames": self.frames, "filtered": self.skipped, "transport_dropped": sum(stream.dropped for stream in self.streams),
            "operations": self.counts,
            **({"started_ns": self.started, "ended_ns": self.ended} if self.started is not None else {}),
            **({"error": self.error} if self.error else {}),
        }

    async def stop(self):
        if not self.closed:
            self.closed = True
            for task in self.tasks:
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            for stream in self.streams:
                stream.close()
            # Closing writes rosbag metadata before the final acknowledgement.
            if self.writer is not None:
                self.writer.close()
                self.writer = None
            if self.index:
                self.index.close()
        return self.facts()


async def main():
    output = sys.stdout
    sys.stdout = sys.stderr

    def reply(data):
        output.write(json.dumps(data, allow_nan=False) + "\n")
        output.flush()

    config = json.loads(sys.stdin.readline())
    recording = None
    try:
        async with communication(config["catalog"], domain_id=config["domain_id"]) as io:
            recording = Recording(io, config["dir"], config["operations"], config["rate"])
            try:
                recording.start()
                reply({"ready": True, **recording.facts()})
                while line := await asyncio.to_thread(sys.stdin.readline):
                    command = json.loads(line)
                    if command["action"] == "stop":
                        reply({"done": True, **await recording.stop()})
                        break
                    if command["action"] != "status":
                        raise ValueError("unknown recording control")
                    reply(recording.facts())
            finally:
                await recording.stop()
    except Exception as error:
        reply({"status": "error", "error": str(error)})


if __name__ == "__main__":
    asyncio.run(main())
