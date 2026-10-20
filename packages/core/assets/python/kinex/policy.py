"""Cartesian policy chunks become absolute joint buffers before any write."""

import math

from kinex.geometry import compose_rt, xyzq_to_rt
from kinex.validation import vector


def cartesian_width(entry, prof):
    space = entry.get("space", "device")
    if space not in {"device", "pose", "pose_delta"}:
        raise ValueError(f"unknown policy space: {space}")
    if space == "device":
        if "frame" in entry or "target_frame" in entry:
            raise ValueError("frame and target_frame require Cartesian policy actions")
        return None
    if prof["type"] != "joint" or not (prof["intrinsics"].get("kinematics") or {}).get("ik"):
        raise ValueError("Cartesian policy actions require a joint device with declared IK")
    return 7 if space == "pose" else 6


def delta_pose(current, action):
    """Translation and rotation increments use fixed reference-frame axes."""
    action = vector(action, 6, "pose_delta")
    angle = math.hypot(*action[3:])
    scale = math.sin(angle / 2) / angle if angle else 0.5
    rotation = xyzq_to_rt([0, 0, 0, *[v * scale for v in action[3:]], math.cos(angle / 2)])
    return compose_rt(rotation, (current[0], [0, 0, 0]))[0], [a + b for a, b in zip(current[1], action[:3])]
