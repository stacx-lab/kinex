"""JSON-ready values for the host dialog: ROS messages and NumPy values become plain data."""
import math
import tempfile
from pathlib import Path

IMAGES = ("sensor_msgs/Image", "sensor_msgs/CompressedImage")


def _save(image, kind):
    if kind == IMAGES[0]:
        from kinex.common.camera import save
        return save(image)
    suffix = ".png" if "png" in image.format.lower() else ".jpg"
    with tempfile.NamedTemporaryFile(prefix="kinex-observation-", suffix=suffix, delete=False) as file:
        file.write(bytes(image.data))
    return file.name


def plain(value, files=None):
    """Convert messages, arrays and tuples recursively; non-finite floats become None.

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
        if any(image in field for field in fields.values() for image in IMAGES):
            return {name: plain(getattr(value, name), files) for name in fields}
        from rosidl_runtime_py.convert import message_to_ordereddict
        return plain(message_to_ordereddict(value))
    if hasattr(value, "tolist"):  # NumPy arrays and scalars, array.array
        return plain(value.tolist(), files)
    return value
