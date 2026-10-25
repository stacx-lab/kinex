"""Helpers for Kinex Python execution; helpers.txt in this package is the index.

Each helper loads its module on first use, so importing helpers stays cheap.
"""
from importlib import import_module

_MODULES = {
    "lookup_transform": "frames", "transform_pose": "frames", "relative_pose": "frames",
    "joint_model": "kinematics", "trajectory": "motion",
    "run_policy": "policy", "locate_object_3d": "perception",
    "camera_frame": "images", "image_array": "images", "save_image": "images",
}
__all__ = sorted(_MODULES)


def __getattr__(name):
    if name not in _MODULES:
        raise AttributeError(f"kinex.helpers has no helper {name!r}")
    return getattr(import_module(f"{__name__}.{_MODULES[name]}"), name)
