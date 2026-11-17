"""JSON-ready values for the host dialog: ROS messages, poses and NumPy values become plain data."""
import dataclasses
import math
import tempfile
from pathlib import Path

IMAGES = ("sensor_msgs/Image", "sensor_msgs/CompressedImage")
TIMES = ("builtin_interfaces/Time", "builtin_interfaces/Duration")


def _save(image, kind):
    if kind == IMAGES[0]:
        from kinex.common.camera import save
        return save(image)
    suffix = ".png" if "png" in image.format.lower() else ".jpg"
    with tempfile.NamedTemporaryFile(prefix="kinex-observation-", suffix=suffix, delete=False) as file:
        file.write(bytes(image.data))
    return file.name


def plain(value, files=None):
    """Convert messages, poses, arrays, records and tuples recursively; non-finite floats become None.

    A pose is written [x, y, z, qx, qy, qz, qw] and a time or duration as seconds.
    Images are files, never data. With a files list, an image message is saved and
    replaced by {file, frame, stamp} and a Path becomes its string; both paths are
    appended in order. Without one they are rejected.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: plain(item, files) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item, files) for item in value]
    if isinstance(value, Path):
        if files is None:
            raise TypeError("a file path is returned only as part of an exec result")
        files.append(str(value))
        return files[-1]
    if hasattr(value, "get_fields_and_field_types"):
        kind = f"{type(value).__module__.split('.')[0]}/{type(value).__name__}"
        fields = value.get_fields_and_field_types()
        if kind in IMAGES:
            if files is None:
                raise TypeError("images are not data; return them as part of an exec result")
            stamp = value.header.stamp
            files.append(_save(value, kind))
            return {"file": files[-1], "frame": value.header.frame_id, "stamp": stamp.sec + stamp.nanosec / 1e9}
        if kind in TIMES:
            return value.sec + value.nanosec / 1e9
        return {name: plain(getattr(value, name), files) for name in fields}
    if hasattr(value, "as_components"):  # scipy RigidTransform
        from kinex.values import components
        return components(value).tolist()
    if hasattr(value, "tolist"):  # NumPy arrays and scalars, array.array
        return plain(value.tolist(), files)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {field.name: plain(getattr(value, field.name), files) for field in dataclasses.fields(value)}
    if isinstance(value, (bytes, bytearray)):
        return list(value)
    return value
