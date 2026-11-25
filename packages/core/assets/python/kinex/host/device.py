"""A device's owned nodes and low-volume host control, apart from the runtime that programs attach to: a device
stops, and answers the host, whatever a program is doing. Stream payloads stay in ROS."""
import asyncio
import importlib.util
import json
import sys

from kinex.communication import WAIT, communication, seconds
from kinex.common.plain import plain


def has_links(profile):
    """Whether Kinex publishes the device's URDF links.

    Only joint and gripper profiles declare a URDF model. Its facts must be known, and
    the links follow the device's joint_state operation.
    """
    model = profile.get("model")
    return (profile.get("type") in ("joint", "gripper") and isinstance(model, dict) and model.get("format") == "urdf"
            and "???" not in model.values() and "joint_state" in profile["operations"])


def observation(message):
    """Selected host observations; ROS-to-ROS payloads never use this path."""
    if isinstance(message, dict):
        return message
    from sensor_msgs.msg import Image, JointState
    from kinex.common.camera import save
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
        # The host holds its scope across requests, each in its own task, so it never makes it ambient.
        self.io = communication(catalog, domain_id=config.get("domain_id", 0)).open()
        bridge = self.io.bridge
        for index, definition in enumerate(config.get("nodes", [])):
            spec = importlib.util.spec_from_file_location(f"kinex_device_{index}", definition["entry"])
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            node = getattr(module, definition.get("factory", "create"))(profile, bridge.context)
            bridge.extra_nodes.append(node)
            bridge.executor.add_node(node)
        from kinex.common.frames import publish_profile
        publish_profile(bridge.node, profile)
        if has_links(profile):
            from kinex.host.links import LinkPublisher
            # The host runs in the device directory, where the profile's URDF path resolves.
            links = LinkPublisher(profile, bridge.context, ".")
            bridge.extra_nodes.append(links)
            bridge.executor.add_node(links)
        await self.ready()
        return {"ready": True}

    async def ready(self):
        async with asyncio.timeout(self.profile["runtime"].get("ready_timeout_s", 30)):
            from rosidl_runtime_py.utilities import get_service
            node, name = self.io.bridge.node, self.profile["name"]
            for extra in self.io.bridge.extra_nodes:
                ready = getattr(extra, "ready", None)
                if ready is not None:
                    await ready()
            clients = []
            try:
                for operation, op in self.profile["operations"].items():
                    if op["transport"] == "service":
                        client = node.create_client(get_service(op["type"]), op["endpoint"])
                        clients.append(client)
                        while not client.service_is_ready():
                            await asyncio.sleep(.02)
                    elif op["transport"] == "action":
                        await self.io._action(f"{name}.{operation}", op)
                    elif op["direction"] == "output":
                        endpoint = op["endpoint"]
                        while not node.count_publishers(endpoint):
                            await asyncio.sleep(.02)
                    else:
                        while not node.count_subscribers(op["endpoint"]):
                            await asyncio.sleep(.02)
            finally:
                for client in clients:
                    node.destroy_client(client)

    async def run(self, action, args):
        if action == "load":
            return await self.load(args["profile"], args.get("clock"))
        if action == "unload":
            if self.io:
                pending = [task for task in self.tasks.values() if task is not asyncio.current_task()]
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                await self.stop()
                await self.io.close()
                self.io = None
            return {"unloaded": True}
        if not self.io:
            raise RuntimeError("device is unloaded")
        if action == "status":
            await self.ready()
            return {"ready": True}
        if action == "stop":
            return await self.stop()
        device = self.io.device(self.profile["name"])
        if action == "$sample":
            configured = self.profile["runtime"].get("observation")
            if not configured and self.profile["type"] in ("rgb", "rgbd"):
                from kinex.common.camera import frame, save, stereo, stereo_frame
                if stereo(self.profile):
                    images = dict(zip(("left", "right"), await stereo_frame(device)))
                    sample = {f"{eye}_{key}": value for eye, image in images.items()
                              for key, value in observation(image).items()}
                    # Timestamp the pair by its later eye; each eye retains its own stamp.
                    return {**sample, "timestamp": max(sample["left_timestamp"], sample["right_timestamp"])}
                # One acquisition: the image and, for rgbd, its equally stamped depth.
                image, depth = await frame(device)
                return {**observation(image), **({"depth_file": save(depth)} if depth is not None else {})}
            candidates = [name for name, op in device.operations.items()
                          if op["direction"] == "output" and op["type"] in
                          ("sensor_msgs/msg/JointState", "sensor_msgs/msg/Image")]
            action = configured or (candidates[0] if candidates else None)
            if not action:
                raise ValueError("declare runtime.observation for this device")
        op = device.operations[action]
        if op["direction"] == "output":
            stream = device.topic(action, depth=1)
            try:
                return observation(await stream.next())
            finally:
                stream.close()
        if op["transport"] == "service":
            try:
                return observation(await device.service(action)(**args))
            except BaseException:
                if op["type"] == WAIT:  # an abandoned wait would keep advancing a stepped world
                    await self.stop()
                raise
        await device.topic(action).publish(args)
        return {"published": True}

    async def stop(self):
        op = self.profile["operations"].get("stop")
        if op:
            return plain(await self.io._request(f"{self.profile['name']}.stop", op, {}))
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
            await host.run("unload", {})


if __name__ == "__main__":
    asyncio.run(main())
