"""JSON-ready values for the host dialog: ROS messages, poses and NumPy values become plain data."""
import dataclasses
import math
import tempfile
from pathlib import Path

IMAGES = ("sensor_msgs/Image", "sensor_msgs/CompressedImage")
TIMES = ("builtin_interfaces/Time", "builtin_interfaces/Duration")


def ros_type(cls):
    """A ROS message class as package/Name."""
    return f"{cls.__module__.split('.')[0]}/{cls.__name__}"


def image_file(value):
    """The file of an image: a path as given, an image message saved; None for anything else."""
    if isinstance(value, (str, Path)):
        return str(value)
    name = ros_type(type(value))
    if name == IMAGES[0]:
        from kinex.common.camera import save
        return save(value)
    if name != IMAGES[1]:
        return None
    suffix = ".png" if "png" in value.format.lower() else ".jpg"
    with tempfile.NamedTemporaryFile(prefix="kinex-observation-", suffix=suffix, delete=False) as file:
        file.write(bytes(value.data))
    return file.name


def plain(value):
    """Convert messages, poses, arrays, records and tuples recursively; non-finite floats become None.

    A pose is written [x, y, z, qx, qy, qz, qw], a time or duration as seconds and a
    Path as its string. Images are files, never data: an image message is rejected.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "get_fields_and_field_types"):
        name = ros_type(type(value))
        if name in IMAGES:
            raise TypeError("images are not data: attach them with finish(result, file=[image])")
        if name in TIMES:
            return value.sec + value.nanosec / 1e9
        return {field: plain(getattr(value, field)) for field in value.get_fields_and_field_types()}
    if hasattr(value, "as_components"):  # scipy RigidTransform
        from kinex.values import components
        return components(value).tolist()
    if hasattr(value, "tolist"):  # NumPy arrays and scalars, array.array
        return plain(value.tolist())
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {field.name: plain(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, (bytes, bytearray)):
        return list(value)
    return value
