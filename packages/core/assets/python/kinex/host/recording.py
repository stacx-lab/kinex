"""Passive, typed topic recording. World time controls sampling, never progress.

Each kind of data is kept in the form that suits it. 8-bit color images go to H.264
video, which is lossy and two to three orders smaller than the pixels; an operation
recorded with format "bag" keeps its messages instead. Everything else, depth
included, stays a typed message in an MCAP bag with zstd chunks, which is lossless.
The clock and TF are recorded once for the domain, by the capture started with tf.
"""
import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time

from kinex.communication import communication

IMAGE = "sensor_msgs/msg/Image"
# The encodings video stores, by ffmpeg's name for their pixels, with their bytes per pixel.
PIXELS = {"rgb8": ("rgb24", 3), "bgr8": ("bgr24", 3), "rgba8": ("rgba", 4), "bgra8": ("bgra", 4), "mono8": ("gray", 1)}
# Chunk compression at zstd's default level: a 640x480 depth frame costs about 2 ms and keeps under a third.
MCAP = "compression: Zstd\ncompressionLevel: Default\n"


class Video:
    """An image operation's frames as H.264 in fragmented MP4, which stays readable if capture dies.

    Frames are stored in arrival order at a nominal rate: the sample index, not the
    video's own timeline, gives each frame's file, position and times. A frame of
    another size or encoding starts the next file.
    """

    def __init__(self, encoder, directory, stem, rate):
        self.encoder, self.directory, self.stem, self.rate = encoder, Path(directory), stem, rate
        self.files, self.process, self.shape, self.frame = [], None, None, 0
        self.lock = threading.Lock()  # a frame is written whole, or not at all, before the stream closes

    def open(self, shape):
        width, height, pixels = shape
        name = f"{self.stem}.{len(self.files)}.mp4" if self.files else f"{self.stem}.mp4"
        self.process = subprocess.Popen([
            self.encoder, "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", pixels, "-s", f"{width}x{height}",
            "-framerate", f"{self.rate:g}", "-i", "-",
            # yuv420p halves chroma, so odd sizes are padded by a pixel.
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            # About a keyframe a second, each starting a fragment a reader can seek to.
            "-g", str(max(1, round(self.rate))), "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
            str(self.directory / name),
        ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)  # stdout is the capture's control channel
        self.files.append(name)
        self.shape, self.frame = shape, 0

    def put(self, process, data):
        with self.lock:
            process.stdin.write(data)

    async def write(self, message):
        pixels, channels = PIXELS[message.encoding]
        shape = (message.width, message.height, pixels)
        if shape != self.shape:
            await self.close()
            self.open(shape)
        row, data = message.width * channels, memoryview(message.data)
        if message.step != row:  # rows padded past their pixels
            import numpy as np
            data = np.frombuffer(data, np.uint8).reshape(message.height, message.step)[:, :row].tobytes()
        position = self.frame
        await asyncio.to_thread(self.put, self.process, data)
        self.frame += 1
        return {"file": self.files[-1], "frame": position}

    def end(self, process):
        with self.lock:
            process.stdin.close()
        return process.wait(timeout=30)

    async def close(self):
        process, self.process, self.shape = self.process, None, None
        if process is None:
            return
        try:
            code = await asyncio.to_thread(self.end, process)
        finally:
            process.kill()
        if code:
            raise RuntimeError(f"video encoder exited {code} writing {self.files[-1]}")


class Recording:
    """Capture of a device's operations, each at its own rate and format, or of the domain's clock and TF."""

    def __init__(self, io, directory, operations, tf=False):
        self.io, self.directory = io, Path(directory)
        # operation -> {"rate": maximum Hz in world time, "format": "video", "bag" or None for its type's own}
        self.operations, self.tf = operations, tf
        self.periods = {name: max(1, round(1e9 / spec["rate"])) for name, spec in operations.items()}
        self.tasks, self.streams = [], []
        self.counts, self.last = {}, {}
        self.samples = self.skipped = self.frames = 0
        self.error = None
        self.writer = self.index = self.storage = None
        self.topics, self.videos = {}, {}
        self.started = self.ended = None
        self.closed = False
        self.wall, self.monotonic = time.time_ns(), time.monotonic_ns()

    def start(self):
        import rosbag2_py
        self.directory.mkdir(parents=True, exist_ok=True)
        self.writer = rosbag2_py.SequentialWriter()
        # MCAP is self-describing and compresses by chunk; an environment without its plugin keeps SQLite.
        self.storage = "mcap" if "mcap" in getattr(rosbag2_py, "get_registered_writers", set)() else "sqlite3"
        options = {"uri": str(self.directory / "bag"), "storage_id": self.storage}
        if self.storage == "mcap":
            (self.directory / "storage.yaml").write_text(MCAP)
            options["storage_config_uri"] = str(self.directory / "storage.yaml")
        self.writer.open(rosbag2_py.StorageOptions(**options), rosbag2_py.ConverterOptions("cdr", "cdr"))
        self.index = (self.directory / "samples.jsonl").open("w", buffering=1)
        catalog, selected = self.io.catalog, list(self.operations)
        if self.tf:
            # The time and frame authorities needed to interpret every device's observations.
            catalog["_frames.dynamic"] = {
                "transport": "topic", "direction": "output", "endpoint": "/tf",
                "type": "tf2_msgs/msg/TFMessage", "qos": {"depth": 64, "durability": "transient_local"}}
            catalog["_frames.static"] = {**catalog["_frames.dynamic"], "endpoint": "/tf_static",
                                         "qos": {"depth": 64, "durability": "transient_local"}}
            selected += ["_frames.dynamic", "_frames.static",
                         *[name for name, op in catalog.items() if op["type"] == "rosgraph_msgs/msg/Clock"]]
        selected, endpoints = list(dict.fromkeys(selected)), {}
        for name in selected:
            op = self.io.operation(name, "topic")
            if op["endpoint"] in endpoints:
                if endpoints[op["endpoint"]] != op["type"]:
                    raise ValueError("one topic cannot have multiple recording types")
                continue
            endpoints[op["endpoint"]] = op["type"]
            stream = self.io.subscribe(op, 64)
            self.streams.append(stream)
            self.counts[name] = 0
            self.tasks.append(asyncio.create_task(self.consume(name, op, stream)))
        (self.directory / "operations.json").write_text(
            json.dumps({name: catalog[name] for name in selected}, indent=2) + "\n")

    def topic(self, op):
        """The operation's bag topic, declared when its first message is written."""
        import rosbag2_py
        if op["endpoint"] not in self.topics:
            fields = dict(name=op["endpoint"], type=op["type"], serialization_format="cdr")
            try:
                metadata = rosbag2_py.TopicMetadata(id=len(self.topics) + 1, **fields)
            except TypeError:  # Humble's rosbag2 has no topic ids.
                metadata = rosbag2_py.TopicMetadata(**fields)
            self.writer.create_topic(metadata)
            self.topics[op["endpoint"]] = metadata
        return op["endpoint"]

    def video(self, name, op, message):
        """The operation's encoder when this frame goes to video: 8-bit color, unless its bag was asked for."""
        spec = self.operations.get(name)
        if spec is None or op["type"] != IMAGE or spec.get("format") == "bag":
            return None
        asked, encoder = spec.get("format") == "video", shutil.which("ffmpeg")
        if message.encoding not in PIXELS:
            if asked:
                raise ValueError(f"video stores 8-bit color, not {message.encoding}; record it with format bag")
            return None
        if encoder is None:
            if asked:
                raise RuntimeError("video needs ffmpeg in the Kinex Python environment")
            return None
        if name not in self.videos:
            self.videos[name] = Video(encoder, self.directory, name.rsplit(".", 1)[-1], spec["rate"])
        return self.videos[name]

    async def consume(self, name, op, stream):
        from rclpy.serialization import serialize_message
        try:
            while True:
                message = await stream.next()
                # Startup can receive retained calibration before the first clock.
                # Wait only for transport; do not request world advancement.
                while self.io.bridge.world_stamp is None:
                    await asyncio.sleep(.01)
                stamp, epoch = self.io.bridge.world_stamp, self.io.bridge.world_epoch
                previous = self.last.get(name)
                if name in self.operations and op["direction"] == "output" and op["type"] != "rosgraph_msgs/msg/Clock":
                    if previous is not None and previous[0] == epoch and stamp - previous[1] < self.periods[name]:
                        self.skipped += 1
                        continue
                self.last[name] = (epoch, stamp)
                received = self.wall + time.monotonic_ns() - self.monotonic
                video = self.video(name, op, message)
                if video is not None:
                    stored = await video.write(message)
                else:
                    # Bag receive time is monotonic across world resets; original ROS
                    # stamps and the explicit epoch/world-time index retain simulation time.
                    self.writer.write(self.topic(op), serialize_message(message), received)
                    stored = {}
                header = getattr(message, "header", None)
                acquisition_stamp = header.stamp if header else getattr(message, "stamp", None)
                acquisition = (acquisition_stamp.sec * 1_000_000_000 + acquisition_stamp.nanosec) if acquisition_stamp is not None else None
                self.index.write(json.dumps({
                    "operation": name, "topic": op["endpoint"], "type": op["type"],
                    "epoch": epoch, "world_ns": stamp, "received_ns": received,
                    "source_ns": acquisition,
                    **({"frame_id": header.frame_id} if header else {}),
                    **stored,
                }) + "\n")
                self.counts[name] += 1
                if name in self.operations:
                    self.samples += 1
                    self.frames += int(op["type"] in (IMAGE, "sensor_msgs/msg/CompressedImage"))
                    self.started = stamp if self.started is None else self.started
                    self.ended = stamp
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.error = f"{name}: {error}"

    def facts(self):
        return {
            "status": "error" if self.error else "stopped" if self.closed else "recording",
            "bag": str(self.directory / "bag"), "storage": self.storage, "timestamps": str(self.directory / "samples.jsonl"),
            "videos": {name: [str(self.directory / file) for file in video.files] for name, video in self.videos.items()},
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
            for name, video in self.videos.items():
                try:
                    await video.close()
                except Exception as error:
                    self.error = self.error or f"{name}: {error}"
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
            recording = Recording(io, config["dir"], config["operations"], config.get("tf", False))
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
