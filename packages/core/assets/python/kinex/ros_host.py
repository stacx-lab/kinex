"""Owned device nodes and low-volume host control; stream payloads stay in ROS."""
import asyncio
import importlib.util
import json
import math
import sys

from kinex.communication import communication


def plain(message):
    from rosidl_runtime_py.convert import message_to_ordereddict
    return message_to_ordereddict(message)


def finite(value):
    """JSON has no NaN or infinity; unavailable measurements become null."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: finite(item) for key, item in value.items()}
    if isinstance(value, list):
        return [finite(item) for item in value]
    return value


def observation(message):
    """Selected host observations; ROS-to-ROS payloads never use this path."""
    if isinstance(message, dict):
        return message
    from sensor_msgs.msg import Image, JointState
    from kinex.camera import save
    if isinstance(getattr(message, "image", None), Image):
        depth = getattr(message, "depth_image", None)
        return {**observation(message.image), **({"depth_file": save(depth)} if depth is not None else {})}
    if isinstance(message, Image):
        return {"file": save(message), "timestamp": message.header.stamp.sec + message.header.stamp.nanosec / 1e9,
                "frame_id": message.header.frame_id, "width": message.width, "height": message.height}
    if isinstance(message, JointState):
        return finite({"positions": list(message.position), "velocities": list(message.velocity),
                       "joint_names": list(message.name), "faults": [],
                       "timestamp": message.header.stamp.sec + message.header.stamp.nanosec / 1e9})
    return finite(dict(plain(message)))


class DeviceHost:
    def __init__(self):
        self.profile = None
        self.io = None
        self.resources = []
        self.tasks = {}

    async def load(self, profile, clock=None):
        if self.io is not None:
            return {"ready": True}
        self.profile = profile
        config = profile["runtime"]
        catalog = {}
        if clock:
            catalog["_world.time"] = clock
        catalog.update({f"{profile['name']}.{name}": op for name, op in profile["operations"].items()})
        self.io = await communication(catalog, domain_id=config.get("domain_id", 0)).__aenter__()
        for index, definition in enumerate(config.get("nodes", [])):
            spec = importlib.util.spec_from_file_location(f"kinex_device_{index}", definition["entry"])
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            node = getattr(module, definition.get("factory", "create"))(profile, self.io.context)
            self.io.extra_nodes.append(node)
            self.io.executor.add_node(node)
        from kinex.ros_frames import publish_profile
        self.resources.extend(publish_profile(self.io.node, profile))
        await self.ready()
        return {"ready": True}

    async def ready(self):
        async with asyncio.timeout(self.profile["runtime"].get("ready_timeout_s", 30)):
            from rosidl_runtime_py.utilities import get_service
            for node in self.io.extra_nodes:
                ready = getattr(node, "ready", None)
                if ready is not None:
                    await ready()
            clients = []
            try:
                for op in self.profile["operations"].values():
                    if op["transport"] == "service":
                        client = self.io.node.create_client(get_service(op["type"]), op["endpoint"])
                        clients.append(client)
                        while not client.service_is_ready():
                            await asyncio.sleep(.02)
                    elif op["direction"] == "output":
                        endpoint = op["endpoint"]
                        while not self.io.node.count_publishers(endpoint):
                            await asyncio.sleep(.02)
                    else:
                        while not self.io.node.count_subscribers(op["endpoint"]):
                            await asyncio.sleep(.02)
            finally:
                for client in clients:
                    self.io.node.destroy_client(client)

    async def run(self, action, args, owner):
        if action == "$frames":
            from kinex.ros_frame_graph import FrameGraphNode
            self.io = await communication({"_world.time": args["clock"]}, domain_id=args["domain_id"]).__aenter__()
            self.io.frame_service = {"endpoint": args["endpoint"], "type": "kinex_interfaces/srv/LookupTransform"}
            self.graph = FrameGraphNode(args["clock"], args["endpoint"], self.io.context)
            self.io.extra_nodes.append(self.graph)
            self.io.executor.add_node(self.graph)
            return {"ready": True}
        if action == "$frame_device":
            self.graph.buffer.device(args["name"], args["active"])
            return {"ready": True}
        if action == "load":
            return await self.load(args["profile"], args.get("clock"))
        if action == "unload":
            if self.io:
                pending = [task for task in self.tasks.values() if task is not asyncio.current_task()]
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                if self.profile is not None:
                    await self.stop()
                await self.io.__aexit__(None, None, None)
                self.io = None
            return {"unloaded": True}
        if not self.io:
            raise RuntimeError("device is unloaded")
        if action == "status":
            await self.ready()
            return {"ready": True}
        if action == "$cleanup":
            # Use a separate client scope: never change an owner's identity on
            # a shared connection while other calls are in flight.
            async with communication(self.io.catalog, owner=owner, domain_id=self.io.domain_id) as io:
                io.enrolled.add(self.profile["name"])
                if args["failed"]:
                    await io.cleanup_owned()
                else:
                    for op in self.profile["operations"].values():
                        if op.get("cancellation"):
                            await io._request(op["cancellation"], {"owner": owner, "request_id": ""}, 2)
            return {"cleaned": True}
        if action == "stop":
            return await self.stop(owner or "")
        if action == "$sample":
            configured = self.profile["runtime"].get("observation")
            candidates = [(name, op) for name, op in self.profile["operations"].items()
                          if op["direction"] == "output" and op["type"] in
                          ("sensor_msgs/msg/JointState", "sensor_msgs/msg/Image", "rosgraph_msgs/msg/Clock")]
            action = configured or ("capture" if "capture" in self.profile["operations"] else
                                    candidates[0][0] if candidates else None)
            if not action:
                raise ValueError("declare runtime.observation for this device")
        reference = f"{self.profile['name']}.{action}"
        op = self.io.operation(reference)
        async with communication(self.io.catalog, owner=owner, domain_id=self.io.domain_id) as io:
            if op["transport"] == "service":
                return observation(await io.request(reference, **args))
            if op["direction"] == "input":
                command_id = await io.publish(reference, args)
                if command_id:
                    await io.accepted(reference, command_id)
                return {"published": True, "command_id": command_id}
            stream = io.subscribe(reference)
            value = await stream.next(timeout_s=op.get("timeout_s", 10))
            return observation(value)

    async def stop(self, owner=""):
        op = self.profile["operations"].get("stop")
        if op:
            return dict(plain(await self.io._request(op, {"owner": owner})))
        # Passive devices declare the built-in no-op stop.
        return {"success": True, "stopped": False}


async def main():
    host = DeviceHost()
    output = sys.stdout
    sys.stdout = sys.stderr
    def reply(value):
        output.write(json.dumps(value, allow_nan=False) + "\n")
        output.flush()
    async def handle(value):
        identifier = value["id"]
        try:
            result = await host.run(value["action"], value.get("args", {}), value.get("owner"))
            reply({"id": identifier, "ok": True, "data": result})
        except BaseException as error:
            reply({"id": identifier, "ok": False, "error": str(error) or type(error).__name__})
        finally:
            host.tasks.pop(identifier, None)
    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            value = json.loads(line)
            if "cancel" in value:
                task = host.tasks.get(value["cancel"])
                if task:
                    task.cancel()
                continue
            task = asyncio.create_task(handle(value))
            host.tasks[value["id"]] = task
    finally:
        for task in list(host.tasks.values()):
            task.cancel()
        await asyncio.gather(*host.tasks.values(), return_exceptions=True)
        if host.io:
            await host.run("unload", {}, None)


if __name__ == "__main__":
    asyncio.run(main())
