"""Express stamped frame-attached poses through tf2."""
from kinex import helpers
from kinex.motion import pose


async def main(a, io):
    from kinex.ros_tools import relative_pose
    child, parent = a["child"], a["parent"]
    stamp = None
    if "timestamp" in a:
        from builtin_interfaces.msg import Time
        from kinex.ros_tools import duration
        stamp = Time(**duration(a["timestamp"]))
    transform = await helpers.lookup_transform(io, parent["frame"], child["frame"], stamp)
    local_child = pose(child.get("pose", [0, 0, 0, 0, 0, 0, 1]))
    local_parent = pose(parent.get("pose", [0, 0, 0, 0, 0, 0, 1]))
    return {"pose": relative_pose(transform, local_child, local_parent),
            "timestamp": transform.header.stamp.sec + transform.header.stamp.nanosec / 1e9}
