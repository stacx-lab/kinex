"""Reusable computation over protocol operations; no persistent tool instances."""
import asyncio
import importlib.util
from pathlib import Path
import uuid

from kinex.communication import _active, communication


async def call(tool, **values):
    from kinex import _request
    entries = (_request or {}).get("tools", {})
    if tool not in entries:
        raise KeyError(f"unknown Python tool {tool}")
    module = load(entries[tool])
    io = _active.get()
    if io is not None:
        return await module.main(values, io)
    async with communication() as io:
        return await module.main(values, io)


def load(file):
    spec = importlib.util.spec_from_file_location("kinex_tool_" + uuid.uuid4().hex, Path(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(file, values):
    async def invoke():
        async with communication() as io:
            return await load(file).main(values, io)
    return asyncio.run(invoke())


def duration(seconds):
    nanoseconds = round(seconds * 1e9)
    return {"sec": nanoseconds // 1_000_000_000, "nanosec": nanoseconds % 1_000_000_000}


def pose_fields(value):
    from kinex.motion import pose
    values = list(map(float, pose(value)))
    return {"position": dict(zip("xyz", values[:3])), "orientation": dict(zip("xyzw", values[3:]))}


async def lookup(io, target, source, stamp=None, timeout_s=5):
    services = [name for name, op in io.catalog.items()
                if op.get("type") == "kinex_interfaces/srv/LookupTransform"]
    if len(services) > 1:
        raise ValueError("multiple frame lookup authorities")
    if services:
        from builtin_interfaces.msg import Time as Stamp
        result = await io.request(services[0], target_frame=target,
                                  source_frame=source, stamp=stamp or Stamp(),
                                  wait_s=timeout_s, timeout_s=timeout_s)
        return result.transform
    from rclpy.time import Time
    time = Time.from_msg(stamp) if stamp is not None else Time()
    buffer = io.transforms()
    await io._future(buffer.wait_for_transform_async(target, source, time), timeout_s)
    return buffer.lookup_transform(target, source, time)


async def transform_pose(io, pose, source, target, stamp=None):
    from geometry_msgs.msg import Pose
    from tf2_geometry_msgs import do_transform_pose
    from kinex.communication import message_value
    relation = await lookup(io, target, source, stamp)
    result = do_transform_pose(message_value(Pose, pose_fields(pose)), relation)
    p, q = result.position, result.orientation
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w]


def relative_pose(relation, child_pose, parent_pose):
    """Compose optional local offsets in a call-local tf2 snapshot."""
    from tf2_ros import Buffer
    from rclpy.time import Time
    from kinex.ros_frames import transform
    t, q = relation.transform.translation, relation.transform.rotation
    buffer = Buffer()
    for edge in (
        transform("parent", "child", [t.x, t.y, t.z, q.x, q.y, q.z, q.w]),
        transform("child", "local_child", child_pose),
        transform("parent", "local_parent", parent_pose),
    ):
        buffer.set_transform_static(edge, "kinex_pose_offsets")
    result = buffer.lookup_transform("local_parent", "local_child", Time())
    p, q = result.transform.translation, result.transform.rotation
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w]
