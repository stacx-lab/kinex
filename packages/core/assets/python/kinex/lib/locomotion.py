"""Locomotion commands checked against the profile's modes and declared limits."""

import math

from kinex.lib.geometry import number

TWIST = {"vx": ("linear", "x"), "vy": ("linear", "y"), "vz": ("linear", "z"),
         "wx": ("angular", "x"), "wy": ("angular", "y"), "wz": ("angular", "z")}


def accepted(profile, mode, operation):
    """Raise unless the current mode accepts the operation."""
    if mode not in profile["modes"]:
        raise ValueError(f"the current mode {mode!r} is not a declared mode")
    if operation not in profile["modes"][mode]["accepts"]:
        raise ValueError(f"mode {mode} does not accept {operation}")


def transition(profile, mode, target):
    """Raise unless target is a declared transition from the current mode."""
    if mode not in profile["modes"] or target not in profile["modes"][mode]["transitions"]:
        raise ValueError(f"mode {mode} cannot change to {target}")


def limited(values, declared, limits, kind):
    """Undeclared axes must be zero; strict limits bound the declared ones."""
    for axis, value in values.items():
        number(value, f"{kind}.{axis}")
        if axis not in declared:
            if abs(value) > 1e-9:
                raise ValueError(f"{kind}.{axis} is not commandable")
            continue
        bounds = declared[axis]
        if limits == "strict" and bounds and not bounds["min"] <= value <= bounds["max"]:
            raise ValueError(f"{kind}.{axis} = {value} exceeds [{bounds['min']}, {bounds['max']}]")
    return values


def velocity(profile, twist):
    """Axis values of a body Twist."""
    values = {axis: getattr(getattr(twist, part), field) for axis, (part, field) in TWIST.items()}
    return limited(values, profile["velocity"]["axes"], profile["limits"], "velocity")


def posture(profile, pose):
    """Height and roll/pitch/yaw offsets of a body Pose from the nominal stance."""
    p, q = pose.position, pose.orientation
    if p.x or p.y:
        raise ValueError("posture offsets cannot shift the body horizontally")
    roll = math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y))
    pitch = math.asin(max(-1., min(1., 2 * (q.w * q.y - q.z * q.x))))
    yaw = math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z))
    values = {"height": p.z, "roll": roll, "pitch": pitch, "yaw": yaw}
    return limited(values, profile["posture"], profile["limits"], "posture")
