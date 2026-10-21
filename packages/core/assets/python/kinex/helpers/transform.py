"""Stamped frame lookup using communication-owned ROS resources."""

from kinex.errors import RPCError


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
    from kinex.ros_frames import ros_frame
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
