"""Owned device nodes and low-volume host control; stream payloads stay in ROS."""
import asyncio
import importlib.util
import json
import sys

from kinex.communication import communication, seconds
from kinex.lib.plain import plain


def observation(message):
    """Selected host observations; ROS-to-ROS payloads never use this path."""
    if isinstance(message, dict):
        return message
    from sensor_msgs.msg import Image, JointState
    from kinex.lib.camera import save
    if isinstance(message, Image):
        return {"file": save(message), "timestamp": seconds(message.header.stamp),
                "frame_id": message.header.frame_id, "width": message.width, "height": message.height}
    if isinstance(message, JointState):
        return plain({"positions": list(message.position), "velocities": list(message.velocity),
                      "joint_names": list(message.name),
                      "timestamp": seconds(message.header.stamp)})
    return plain(message)


class DeviceHost:
    def __init__(self):
        self.profile = None
        self.io = None
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
        from kinex.lib.frames import publish_profile
        publish_profile(self.io.node, profile)
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

    async def run(self, action, args):
        if action == "$frames":
            from kinex.host.frame_graph import FrameGraphNode
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
        if action == "stop":
            return await self.stop()
        if action == "$sample":
            configured = self.profile["runtime"].get("observation")
            if not configured and self.profile["type"] in ("rgb", "rgbd"):
                # One acquisition: the image and, for rgbd, its equally stamped depth.
                from kinex.lib.camera import frame, save
                image, depth = await frame(self.io, self.profile["name"])
                return {**observation(image), **({"depth_file": save(depth)} if depth is not None else {})}
            candidates = [(name, op) for name, op in self.profile["operations"].items()
                          if op["direction"] == "output" and op["type"] in
                          ("sensor_msgs/msg/JointState", "sensor_msgs/msg/Image", "rosgraph_msgs/msg/Clock")]
            action = configured or (candidates[0][0] if candidates else None)
            if not action:
                raise ValueError("declare runtime.observation for this device")
        reference = f"{self.profile['name']}.{action}"
        op = self.io.operation(reference)
        if op["direction"] == "output":
            stream = self.io.subscribe(reference)
            try:
                return observation(await stream.next(timeout_s=op.get("timeout_s", 10)))
            finally:
                stream.close()
        # Calls share the loaded connection; an abandoned wait stops its world.
        if op["transport"] == "service":
            return observation(await self.io.request(reference, **args))
        await self.io.publish(reference, args)
        return {"published": True}

    async def stop(self):
        op = self.profile["operations"].get("stop")
        if op:
            return plain(await self.io._request(op, {}))
        # Passive devices declare the built-in no-op stop.
        return {"success": True, "message": "no stop operation"}


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
            result = await host.run(value["action"], value.get("args", {}))
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
