"""Helpers for Kinex Python execution; helpers.txt in this package is the index.

Each helper loads its module on first use, so importing helpers stays cheap.
"""
from importlib import import_module

_MODULES = {
    "camera_geometry": "camera_geometry",
    "lookup_transform": "frames", "transform_pose": "frames", "relative_pose": "frames",
    "joint_model": "kinematics", "trajectory": "motion",
    "locate_object_3d": "perception",
    "camera_frame": "images", "stereo_frame": "images", "image_array": "images", "save_image": "images",
}
__all__ = sorted(_MODULES)


def __getattr__(name):
    if name not in _MODULES:
        raise AttributeError(f"kinex.helpers has no helper {name!r}")
    helper = getattr(import_module(f"{__name__}.{_MODULES[name]}"), name)
    # Importing a submodule binds it on this package under its own name, so a helper named after its module
    # (camera_geometry) would be the module from its second use on; bind the helper instead.
    globals()[name] = helper
    return helper
