"""Image conversion utilities, independent of communication scheduling."""
import tempfile
import numpy as np
from PIL import Image


def array(message):
    formats = {"rgb8": (np.uint8, 3), "bgr8": (np.uint8, 3), "mono8": (np.uint8, 1),
               "16UC1": (np.uint16, 1), "32FC1": (np.float32, 1)}
    if message.encoding not in formats:
        raise ValueError(f"unsupported image encoding {message.encoding}")
    scalar, channels = formats[message.encoding]
    dtype = np.dtype(scalar).newbyteorder(">" if message.is_bigendian else "<")
    stride = message.step // dtype.itemsize
    values = np.frombuffer(message.data, dtype).reshape(message.height, stride)[:, :message.width * channels]
    values = values.reshape(message.height, message.width, channels) if channels != 1 else values
    return values[:, :, ::-1] if message.encoding == "bgr8" else values


def save(message):
    values = array(message)
    if values.dtype.kind == "f":
        # Floating depth retains precision in TIFF.
        extension = ".tiff"
    else:
        extension = ".png"
    with tempfile.NamedTemporaryFile(prefix="kinex-observation-", suffix=extension, delete=False) as file:
        filename = file.name
    Image.fromarray(values).save(filename)
    return filename
