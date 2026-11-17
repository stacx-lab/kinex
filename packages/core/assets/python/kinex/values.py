"""The values a program computes with, and their written forms.

A pose is a scipy RigidTransform; written down, in results, arguments and profiles, it
is [x, y, z, qx, qy, qz, qw] in metres with a unit quaternion. Vectors are NumPy arrays
and time is seconds on the world clock. Functions take these in any equivalent form and
return them in one. Imports are deferred: a program that needs neither pays for neither.
"""
from kinex.common.geometry import QUATERNION_NORM_TOLERANCE


def pose(value):
    """A RigidTransform from a pose in any form.

    Takes a RigidTransform, [x, y, z, qx, qy, qz, qw] or rows of them, or a ROS Pose,
    Transform, PoseStamped or TransformStamped. Several rows make one RigidTransform
    holding that many poses.

    Example: tcp = pose(message) * pose([0, 0, 0.1, 0, 0, 0, 1])
    """
    import numpy as np
    from scipy.spatial.transform import RigidTransform, Rotation
    if isinstance(value, RigidTransform):
        return value
    value = getattr(value, "pose", getattr(value, "transform", value))
    where = getattr(value, "position", getattr(value, "translation", None))
    turn = getattr(value, "orientation", getattr(value, "rotation", None))
    rows = np.array([where.x, where.y, where.z, turn.x, turn.y, turn.z, turn.w]) if where is not None and turn is not None else np.asarray(value, dtype=float)
    if rows.ndim not in (1, 2) or rows.shape[-1] != 7 or not np.isfinite(rows).all():
        raise ValueError("a pose is [x, y, z, qx, qy, qz, qw], or rows of them")
    norms = np.linalg.norm(rows[..., 3:], axis=-1)
    if (np.abs(norms - 1) > QUATERNION_NORM_TOLERANCE).any():
        raise ValueError(f"a pose requires a unit quaternion [qx, qy, qz, qw] (xyzw); got norm {norms.tolist()!r}")
    return RigidTransform.from_components(rows[..., :3], Rotation.from_quat(rows[..., 3:]))


def components(value, single=False):
    """A pose as it is written down: [x, y, z, qx, qy, qz, qw], or one row per pose held."""
    import numpy as np
    transform = pose(value)
    if single and not transform.single:
        raise ValueError("expected one pose, not several")
    return np.concatenate([transform.translation, transform.rotation.as_quat()], axis=-1)
