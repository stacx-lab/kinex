"""Stamped frame lookups through Kinex tf2 history.

Frames are qualified device:frame references or ROS IDs (device/frame). A lookup is a
pose, a scipy RigidTransform, and never advances world time.
"""

from numbers import Real

from kinex import io
from kinex.communication import duration
from kinex.errors import RPCError
from kinex.values import pose


def _stamp(value):
    """A ROS Time: a message's own stamp to the nanosecond, seconds rounded to one, None as the latest."""
    from builtin_interfaces.msg import Time
    if value is None:
        return Time()
    return Time(**duration(value)) if isinstance(value, Real) else getattr(getattr(value, "header", None), "stamp", value)


async def lookup_transform(target, source, stamp=None, timeout_s=5):
    """The pose of source in target: a RigidTransform taking points and poses in source to target.

    Frames may be ROS IDs or qualified device:frame references; a frame is the
    identity in itself, even one absent from TF. stamp selects a world time, in
    seconds or as a stamped message or its stamp; None selects the latest transform.
    timeout_s bounds the wait (0..30 seconds), without advancing world time.
    Missing frames, timeouts and cancellation propagate to the caller; a failed
    lookup names its cause. Supervised calls use Kinex's persistent frame service;
    standalone clients use their communication scope's local history and cleanup.

    Example: goal = await lib.frames.lookup_transform("arm:base", "camera:color", image) * seen
    """
    import math
    from kinex.common.frames import ros_frame
    target, source = ros_frame(target), ros_frame(source)
    if not math.isfinite(timeout_s) or not 0 <= timeout_s <= 30:
        raise ValueError("transform timeout_s must be finite and within 0..30 seconds")
    if target == source:
        return pose([0, 0, 0, 0, 0, 0, 1])
    stamp = _stamp(stamp)
    if io.frame_service:
        result = await io._request(io.frame_service, {
            "target_frame": target, "source_frame": source, "stamp": stamp, "wait_s": timeout_s,
        }, timeout_s + 1)
        return pose(result.transform)
    if io.supervised:
        raise RPCError("Kinex frame service is unavailable; load a ROS device with a configured world clock.",
                       code="frames_unavailable")
    # Explicit standalone ROS clients own only their local subscription history.
    from rclpy.time import Time
    time = Time.from_msg(stamp)
    buffer = io.transforms()
    if timeout_s:
        try:
            await io._future(buffer.wait_for_transform_async(target, source, time), timeout_s)
        except TimeoutError:
            raise TimeoutError(buffer.timed_out(target, source, time, timeout_s)) from None
    return pose(buffer.lookup_transform(target, source, time))

