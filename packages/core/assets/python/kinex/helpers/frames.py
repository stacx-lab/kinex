"""Frame lookups and pose transforms through Kinex tf2 history."""

from kinex.errors import RPCError
from kinex.lib.geometry import compose_rt, flat, invert_rt, pose as validate_pose, xyzq_to_rt

IDENTITY = [0, 0, 0, 0, 0, 0, 1]


async def lookup_transform(io, target, source, stamp=None, timeout_s=5):
    """Return source expressed in target as a ROS TransformStamped.

    Frames may be ROS IDs or qualified device:frame references. A ROS Time
    message selects a world timestamp; None selects the latest transform.
    timeout_s bounds the wait (0..30 seconds), without advancing world time.
    Missing frames, timeouts and cancellation propagate to the caller.
    Supervised calls use Kinex's persistent frame service; standalone clients
    use their communication scope's local history and cleanup.

    Example: await helpers.lookup_transform(io, "arm:base", "camera:base")
    """
    import math
    from kinex.lib.frames import ros_frame
    target, source = ros_frame(target), ros_frame(source)
    from builtin_interfaces.msg import Time as Stamp
    if not math.isfinite(timeout_s) or not 0 <= timeout_s <= 30:
        raise ValueError("transform timeout_s must be finite and within 0..30 seconds")
    if io.frame_service:
        result = await io._request(io.frame_service, {
            "target_frame": target, "source_frame": source,
            "stamp": stamp if stamp is not None else Stamp(), "wait_s": timeout_s,
        }, timeout_s + 1)
        return result.transform
    if io.supervised:
        raise RPCError("Kinex frame service is unavailable; load a ROS device with a configured world clock.",
                       code="frames_unavailable")
    # Explicit standalone ROS clients own only their local subscription history.
    from rclpy.time import Time
    time = Time.from_msg(stamp) if stamp is not None else Time()
    buffer = io.transforms()
    if timeout_s:
        await io._future(buffer.wait_for_transform_async(target, source, time), timeout_s)
    return buffer.lookup_transform(target, source, time)


async def transform_pose(io, pose, source, target, stamp=None):
    """Express a pose [x, y, z, qx, qy, qz, qw] given in source in target.

    Frames are qualified device:frame references or ROS IDs; a frame needs no
    transform to itself, even one absent from TF. stamp selects a world time.

    Example: await helpers.transform_pose(io, goal, "camera:color", "arm:base")
    """
    from geometry_msgs.msg import Pose
    from tf2_geometry_msgs import do_transform_pose
    from kinex.communication import message_value
    from kinex.lib.frames import ros_frame
    if ros_frame(source) == ros_frame(target):
        return list(pose)
    values = list(map(float, validate_pose(pose)))
    message = message_value(Pose, {"position": dict(zip("xyz", values[:3])), "orientation": dict(zip("xyzw", values[3:]))})
    result = do_transform_pose(message, await lookup_transform(io, target, source, stamp))
    p, q = result.position, result.orientation
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w]


async def relative_pose(io, child, parent, timestamp=None):
    """Express a frame-attached child pose relative to a frame-attached parent pose.

    child and parent are {"frame": reference, "pose": [x, y, z, qx, qy, qz, qw]}
    with the pose defaulting to identity. timestamp selects a world time in
    seconds; missing frame relationships and unavailable times are errors.
    Returns {"pose", "timestamp"} of the stamped relation used.

    Example: await helpers.relative_pose(io, {"frame": "gripper:tcp"}, {"frame": "arm:base"})
    """
    stamp = None
    if timestamp is not None:
        from builtin_interfaces.msg import Time
        from kinex.communication import duration
        stamp = Time(**duration(timestamp))
    relation = await lookup_transform(io, parent["frame"], child["frame"], stamp)
    t, q = relation.transform.translation, relation.transform.rotation
    edge = xyzq_to_rt([t.x, t.y, t.z, q.x, q.y, q.z, q.w])
    local_child = xyzq_to_rt(validate_pose(child.get("pose", IDENTITY)))
    local_parent = xyzq_to_rt(validate_pose(parent.get("pose", IDENTITY)))
    stamp = relation.header.stamp
    return {"pose": flat(compose_rt(invert_rt(local_parent), compose_rt(edge, local_child))),
            "timestamp": stamp.sec + stamp.nanosec / 1e9}
