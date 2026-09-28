"""Cartesian policy chunks become absolute joint buffers before any write."""

import math

from kinex import device
from kinex.frames import pose as frame_pose
from kinex.geometry import compose_rt, invert_rt, pose_to_rt, xyzq_to_rt
from kinex.motion import flat, pose
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


def joint_sequence(entry, actions):
    """Resolve one frozen frame snapshot; seed every IK solve from its predecessor."""
    spec, prof, name = entry["spec"], entry["profile"], entry["name"]
    if spec.get("space", "device") == "device":
        return actions
    ik_frame = f"{name}:{prof['intrinsics']['kinematics']['frame']}"
    target = spec.get("target_frame", ik_frame)
    reference = spec.get("frame", name)
    state = device(name).get("data") or {}
    if state.get("faults"):
        raise ValueError(f"{name} reports faults before policy planning")
    seed = vector(state.get("positions"), len(entry["model"]["joints"]), "IK seed")
    readings = {name: state}
    offset = frame_pose(target, ik_frame, readings=readings)
    if any(edge["kind"] != "static" for edge in offset["path"]):
        raise ValueError("target_frame must be rigidly attached to the IK frame")
    target_to_ik = invert_rt(pose_to_rt(offset))
    reference_to_base = pose_to_rt(frame_pose(reference, name, readings=readings))
    measured = pose_to_rt(frame_pose(ik_frame, name, readings=readings))
    current = compose_rt(invert_rt(reference_to_base), compose_rt(measured, pose_to_rt(offset)))
    result = []
    for action in actions:
        current = delta_pose(current, action) if spec["space"] == "pose_delta" else xyzq_to_rt(pose(action))
        goal = flat(compose_rt(compose_rt(reference_to_base, current), target_to_ik))
        solved = device(name, "ik", pose=goal, seed=seed).get("data") or {}
        seed = vector(solved.get("joints"), len(seed), "IK result")
        result.append(seed)
    return result
