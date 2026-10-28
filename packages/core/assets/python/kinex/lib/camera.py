"""Camera projection from profile intrinsics, ROS image conversion and frame reads."""

import asyncio
import tempfile

import numpy as np
from PIL import Image

ENCODINGS = {"rgb8": (np.uint8, 3), "bgr8": (np.uint8, 3), "mono8": (np.uint8, 1), "16UC1": (np.uint16, 1)}


def _pinhole(stream):
    if not isinstance(stream.get("distortion"), dict) or stream["distortion"].get("model") != "none" or not isinstance(stream.get("projection"), dict):
        raise ValueError("camera geometry requires node project/unproject services or explicit undistorted pinhole intrinsics")
    return stream["projection"]


def rays(stream, u, v):
    p = _pinhole(stream)
    y = (np.asarray(v, dtype=float) - p["cy"]) / p["fy"]
    x = (np.asarray(u, dtype=float) - p["cx"] - p["skew"] * y) / p["fx"]
    if not np.all(np.isfinite(x)) or not np.all(np.isfinite(y)):
        raise ValueError("camera pixels must be finite")
    return np.stack((x, y, np.ones_like(x)), axis=-1)


def ray(stream, u, v):
    return rays(stream, u, v).tolist()


def project(stream, point):
    p = _pinhole(stream)
    point = np.asarray(point, dtype=float)
    if not np.all(np.isfinite(point)) or np.any(point[2] <= 0):
        raise ValueError("camera points require finite coordinates and positive Z")
    x, y = point[0] / point[2], point[1] / point[2]
    return p["fx"]*x + p["skew"]*y + p["cx"], p["fy"]*y + p["cy"]


def array(message):
    """Native-order pixels of a sensor_msgs/Image: HxWx3 RGB or HxW mono8/16UC1."""
    if message.encoding not in ENCODINGS:
        raise ValueError(f"unsupported image encoding {message.encoding}")
    scalar, channels = ENCODINGS[message.encoding]
    dtype = np.dtype(scalar).newbyteorder(">" if message.is_bigendian else "<")
    rows = np.frombuffer(message.data, dtype).reshape(message.height, message.step // dtype.itemsize)
    values = rows[:, :message.width * channels].astype(scalar, copy=False)
    if channels == 1:
        return values
    values = values.reshape(message.height, message.width, channels)
    return values[:, :, ::-1] if message.encoding == "bgr8" else values


def save(message):
    """Write an image as a temporary PNG, keeping 16-bit depth, and return its path."""
    with tempfile.NamedTemporaryFile(prefix="kinex-observation-", suffix=".png", delete=False) as file:
        Image.fromarray(array(message)).save(file, format="PNG")
    return file.name


async def frame(io, camera, *, timeout_s=None):
    """The camera's next image and, for an rgbd camera, its depth from the same acquisition.

    Subscribing yields a current frame: live cameras stream, and simulators publish one
    to each new subscriber, also while the world is paused. Depth is paired with the image
    of equal stamp. timeout_s defaults to the image operation's timeout_s.
    """
    names = ["image"] + (["depth"] if f"{camera}.depth" in io.catalog else [])
    streams = [io.subscribe(f"{camera}.{name}") for name in names]
    limit = timeout_s if timeout_s is not None else io.operation(f"{camera}.image").get("timeout_s", 10)

    def stamp(message):
        return message.header.stamp.sec, message.header.stamp.nanosec
    try:
        async with asyncio.timeout(limit):
            latest = [await stream.next() for stream in streams]
            while len(latest) == 2 and stamp(latest[0]) != stamp(latest[1]):
                older = 0 if stamp(latest[0]) < stamp(latest[1]) else 1
                latest[older] = await streams[older].next()
    finally:
        for stream in streams:
            stream.close()
    return latest[0], latest[1] if len(latest) == 2 else None
