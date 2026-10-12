"""Read device-local ROS settings from profile_ros.yaml; no templates or setup state."""

import math
from pathlib import Path
import re

from kinex_ros.ros2 import ROSError


def read_yaml(path):
    import yaml
    return yaml.safe_load(Path(path).read_text())


def load(directory):
    path = Path(directory) / "profile_ros.yaml"
    data = read_yaml(path)
    if not isinstance(data, dict):
        raise ROSError(f"{path}: expected a mapping", "invalid_ros_profile")
    domain = data.get("domain_id", 0)
    if type(domain) is not int or not 0 <= domain <= 232:
        raise ROSError("domain_id must be an integer between 0 and 232", "invalid_ros_profile")
    namespace = data.get("namespace", "")
    if not isinstance(namespace, str) or not re.fullmatch(r"(?:/?[A-Za-z_][A-Za-z0-9_]*(?:/[A-Za-z_][A-Za-z0-9_]*)*|/)?", namespace):
        raise ROSError("namespace must be a valid ROS namespace", "invalid_ros_profile")
    for key in ("expected", "clock", "stop"):
        if key in data and not isinstance(data[key], dict):
            raise ROSError(f"{key} must be a mapping", "invalid_ros_profile")
    for key in ("state_topic", "command_topic", "color_topic", "depth_topic", "camera_info_topic", "depth_camera_info_topic", "adapter"):
        if key in data and (not isinstance(data[key], str) or not data[key]):
            raise ROSError(f"{key} must be a nonempty string", "invalid_ros_profile")
    for key in ("color_image_space", "depth_image_space"):
        if key in data and data[key] not in ("raw", "rectified"):
            raise ROSError(f"{key} must be raw or rectified", "invalid_ros_profile")
    if data.get("timestamp_source", "header") not in ("header", "receipt"):
        raise ROSError("timestamp_source must be header or receipt", "invalid_ros_profile")
    for key in ("period_s", "stale_periods", "connect_timeout_s", "time_from_start_s", "ready_timeout_s"):
        if key in data and (type(data[key]) not in (int, float) or not math.isfinite(data[key]) or data[key] <= 0):
            raise ROSError(f"{key} must be finite and positive", "invalid_ros_profile")
    return {"domain_id": 0, "namespace": "", **data}
