"""JSON-ready values for the host dialog: ROS messages and NumPy values become plain data."""
import math

IMAGES = ("sensor_msgs/Image", "sensor_msgs/CompressedImage")


def plain(value):
    """Convert messages, arrays and tuples recursively; non-finite floats become None."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if hasattr(value, "get_fields_and_field_types"):
        kind = f"{type(value).__module__.split('.')[0]}/{type(value).__name__}"
        if kind in IMAGES or any(image in field for field in value.get_fields_and_field_types().values()
                                 for image in IMAGES):
            raise TypeError("images are not data; return them with finish(file=helpers.save_image(image))")
        from rosidl_runtime_py.convert import message_to_ordereddict
        return plain(message_to_ordereddict(value))
    if hasattr(value, "tolist"):  # NumPy arrays and scalars, array.array
        return plain(value.tolist())
    return value
