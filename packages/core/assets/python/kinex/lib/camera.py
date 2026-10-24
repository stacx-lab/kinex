"""Camera projection from profile intrinsics and ROS image conversion."""

import tempfile

import numpy as np
from PIL import Image

ENCODINGS = {"rgb8": (np.uint8, 3), "bgr8": (np.uint8, 3), "mono8": (np.uint8, 1), "16UC1": (np.uint16, 1)}


def _distort(distortion, x, y):
    if distortion["model"] == "none":
        return x, y
    if distortion["model"] != "opencv_brown_conrady":
        raise ValueError(f'unsupported distortion model: {distortion["model"]}')
    k1, k2, p1, p2, k3 = (distortion[key] for key in ("k1", "k2", "p1", "p2", "k3"))
    r2 = x*x + y*y
    radial = 1 + r2 * (k1 + r2 * (k2 + r2*k3))
    return x*radial + 2*p1*x*y + p2*(r2 + 2*x*x), y*radial + p1*(r2 + 2*y*y) + 2*p2*x*y


def rays(stream, u, v):
    """Optical rays [x, y, 1] for pixel coordinates (scalars or arrays), inverting distortion."""
    p, d = stream["projection"], stream["distortion"]
    yd = (np.asarray(v, dtype=float) - p["cy"]) / p["fy"]
    xd = (np.asarray(u, dtype=float) - p["cx"] - p["skew"] * yd) / p["fx"]
    x, y = xd, yd
    for _ in range(30):
        px, py = _distort(d, x, y)
        ex, ey = px-xd, py-yd
        if np.all(np.hypot(ex, ey) < 1e-10):
            return np.stack((x, y, np.ones_like(x)), axis=-1)
        h = 1e-6
        hx, hy = _distort(d, x+h, y)
        vx, vy = _distort(d, x, y+h)
        a, b, c, e = (hx-px)/h, (vx-px)/h, (hy-py)/h, (vy-py)/h
        det = a*e-b*c
        if np.any(np.abs(det) < 1e-12):
            raise ValueError("singular camera distortion")
        x, y = x-(e*ex-b*ey)/det, y-(a*ey-c*ex)/det
    raise ValueError("camera distortion inversion did not converge")


def ray(stream, u, v):
    """The optical ray [x, y, 1] through one pixel."""
    return rays(stream, u, v).tolist()


def project(stream, point):
    x, y = _distort(stream["distortion"], point[0]/point[2], point[1]/point[2])
    p = stream["projection"]
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
