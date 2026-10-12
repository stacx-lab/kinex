"""Common force/torque reads and rigid transforms. No backend-specific logic."""

import math

from kinex import device, profile
from kinex.geometry import pose_to_rt


def read(name):
    spec = profile(name)
    if spec["type"] != "force_torque":
        raise ValueError("input device must have type force_torque")
    # Dispatch validates and subtracts profile bias. Never subtract it again.
    return device(name)


def transform(sample, pose):
    """Express a corrected sample in a new frame, about its origin.

    pose is T_new_measurement {translation, rotation xyzw}. Partial vectors
    cannot be treated as complete wrenches. Unsupported channels stay null.
    """
    rotation, translation = pose_to_rt(pose)

    def rotate(values):
        if values is None:
            return None
        if set(values) != {"x", "y", "z"}:
            raise ValueError("frame rotation requires all three measured axes")
        vector = [values[axis] for axis in ("x", "y", "z")]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in vector):
            raise ValueError("measurement axes must be finite numbers")
        return [sum(rotation[i][j] * vector[j] for j in range(3)) for i in range(3)]

    force, torque = rotate(sample["force"]), rotate(sample["torque"])
    if torque is not None and any(v != 0 for v in translation):
        if force is None:
            raise ValueError("changing the torque reference point requires measured force")
        x, y, z = translation
        fx, fy, fz = force
        cross = [y * fz - z * fy, z * fx - x * fz, x * fy - y * fx]
        torque = [torque[i] + cross[i] for i in range(3)]
    return {**sample,
            "force": dict(zip(("x", "y", "z"), force)) if force is not None else None,
            "torque": dict(zip(("x", "y", "z"), torque)) if torque is not None else None}
