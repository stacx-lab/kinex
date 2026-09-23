"""Harness-owned, synchronized rest-to-rest joint trajectory generation."""

import math

from kinex.motion import joint_target, vector
from kinex.validation import number


def planning_limits(joints, max_velocity=None, max_acceleration=None):
    """Resolve requested rates against known limits; defaults are planning policy."""
    result = []
    for key, requested, rotary, linear in (
        ("max_velocity", max_velocity, 1.0, 0.1),
        ("max_acceleration", max_acceleration, 3.0, 0.3),
    ):
        values = [None] * len(joints) if requested is None else vector(
            requested if isinstance(requested, list) else [requested] * len(joints), len(joints), key)
        rates = []
        for joint, value in zip(joints, values):
            limit = joint.get(key)
            if limit is not None and number(limit, key) <= 0:
                raise ValueError(f"{key} must be positive")
            if value is None:
                value = linear if joint["type"] == "prismatic" else rotary
            if number(value, key) <= 0:
                raise ValueError(f"{key} must be positive")
            rates.append(min(value, limit) if limit is not None else value)
        result.append(rates)
    return result


def trajectory(joints, start, target, period_s, fraction=1.0, max_velocity=None, max_acceleration=None):
    """Sample synchronized quintic references from a measured resting state."""
    start = joint_target(start, joints)
    target = joint_target(target, joints)
    if not math.isfinite(period_s) or period_s <= 0 or not 0 < fraction <= 1:
        raise ValueError("invalid trajectory period or speed fraction")
    delta, duration = [], period_s
    velocities, accelerations = planning_limits(joints, max_velocity, max_acceleration)
    for joint, a, b, velocity, acceleration in zip(joints, start, target, velocities, accelerations):
        distance = b - a
        if joint["type"] == "continuous":
            distance = math.atan2(math.sin(distance), math.cos(distance))
        delta.append(distance)
        # Exact extrema of 10s^3 - 15s^4 + 6s^5 and its derivatives.
        duration = max(duration, 1.875 * abs(distance) / (velocity * fraction),
                       math.sqrt(10 / math.sqrt(3) * abs(distance) / (acceleration * fraction)))
    count = math.ceil(duration / period_s)
    if count > 1_000_000:
        raise ValueError("trajectory exceeds one million references")
    result = []
    for tick in range(1, count + 1):
        t = tick / count
        scale = t ** 3 * (10 + t * (-15 + 6 * t))
        result.append(joint_target([a + d * scale for a, d in zip(start, delta)], joints))
    return result


def at_rest(state, width, tolerance):
    velocities = vector(state.get("velocities"), width, "measured velocities")
    return all(abs(v) <= limit for v, limit in zip(velocities, tolerance))
