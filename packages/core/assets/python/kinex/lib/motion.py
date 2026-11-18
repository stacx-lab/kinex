"""Synchronized rest-to-rest joint trajectory planning, without device I/O.

A program submits a plan through the device's declared command operation, waits on
the world clock and verifies measured arrival.
"""

import math
from dataclasses import dataclass
from numbers import Real

from kinex.common.geometry import number, vector
from kinex.common.joints import recovery_targets
from kinex.common.urdf import joint_target


@dataclass(frozen=True)
class Trajectory:
    """A complete reference buffer, one row of joint positions per sample, and its planned execution duration."""

    actions: "numpy.ndarray"
    duration_s: float


def planning_limits(joints, max_velocity=None, max_acceleration=None):
    """The velocity and acceleration limits a plan uses: an array of two rows, one value per joint.

    A requested rate, one number or one per joint, is capped by the joint's own limit;
    the default is 1 rad/s and 3 rad/s², or 0.1 m/s and 0.3 m/s² for a prismatic joint.

    Example: velocities, accelerations = lib.motion.planning_limits(arm.joints, max_velocity=0.5)
    """
    result = []
    for key, requested, rotary, linear in (
        ("max_velocity", max_velocity, 1.0, 0.1),
        ("max_acceleration", max_acceleration, 3.0, 0.3),
    ):
        values = [None] * len(joints) if requested is None else vector(
            [requested] * len(joints) if isinstance(requested, Real) else requested, len(joints), key)
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
    import numpy as np
    return np.array(result, dtype=float)


def trajectory(joints, start, target, period_s, fraction=1.0, max_velocity=None, max_acceleration=None, *, check_limits=True, start_tolerance=0):
    """Plan a synchronized rest-to-rest joint move, without device I/O.

    joints are a joint model's joints; start and target are positions in that order.
    Returns Trajectory(actions, duration_s): one row of positions per sample, without
    the start and ending at the target, sample i (from 1) due at
    i * duration_s / len(actions); period_s is the longest sample spacing. fraction
    (0..1] scales the limits that max_velocity and max_acceleration set as in
    planning_limits. Continuous joints take the shorter way round. The target must be
    within joint limits; start_tolerance lets a start outside them move back in.

    Example: plan = lib.motion.trajectory(arm.joints, start, target, period_s=0.01)
    """
    start = joint_target(start, joints, check_limits=False)
    target = joint_target(target, joints, check_limits=check_limits)
    if check_limits:
        recovery_targets([start, target], joints, start_tolerance)
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
        result.append([a + d * scale for a, d in zip(start, delta)])
    result[-1] = [q if j["type"] == "continuous" else goal
                  for q, goal, j in zip(result[-1], target, joints)]
    if check_limits:
        recovery_targets(result, joints, start_tolerance)
    import numpy as np
    return Trajectory(actions=np.array(result, dtype=float), duration_s=duration)
