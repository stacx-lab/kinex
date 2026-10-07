#!/usr/bin/env python3
"""Plan a full joint trajectory and submit it without waiting for arrival."""

import math

from kinex import args, device, finish, profile
from kinex.control import read
from kinex.frames import pose as frame_pose
from kinex.geometry import compose_rt, pose_to_rt, xyzq_to_rt
from kinex.joint_control import project_seed
from kinex.motion import flat, joint_target, pose as unit_pose, vector
from kinex.trajectory import trajectory


def canonical(pose, frame, name):
    """Re-express a pose given in `frame` in the device's canonical frame."""
    if frame is None:
        return pose
    return flat(compose_rt(pose_to_rt(frame_pose(frame, name)), xyzq_to_rt(unit_pose(pose))))


def solve(name, prof, pose, start):
    """Hand one pose to the device's IK driver, which verifies it with FK."""
    if not (prof["intrinsics"].get("kinematics") or {}).get("ik"):
        raise ValueError("pose goals require declared IK")
    seed = project_seed(start, prof["resolved_model"]["joints"])
    joints = (device(name, "ik", pose=unit_pose(pose), seed=seed).get("data") or {}).get("joints")
    if joints is None:
        raise ValueError("ik returned no joints")
    return joints


def goal_joints(a, name, prof, start):
    if a.get("joints") is not None:
        return a["joints"]
    pose = canonical(a["pose"], a.get("frame"), name)
    return solve(name, prof, pose, start)


def check_travel(joints, start, goal, requested):
    """Apply an explicitly requested bound on a single submission's travel."""
    limits = vector(requested if isinstance(requested, list) else [requested] * len(joints),
                    len(joints), "max_joint_delta")
    if any(limit <= 0 for limit in limits):
        raise ValueError("max_joint_delta must be positive")
    exceeded = []
    for joint, a, b, limit in zip(joints, start, goal, limits, strict=True):
        delta = b - a
        if joint["type"] == "continuous":
            delta = math.atan2(math.sin(delta), math.cos(delta))
        if abs(delta) > limit:
            unit = "m" if joint["type"] == "prismatic" else "rad"
            exceeded.append(f"{joint['name']}: measured={a:g}, requested={b:g}, delta={delta:g}, allowed={limit:g} {unit}")
    if exceeded:
        raise ValueError("servo max_joint_delta exceeded: " + "; ".join(exceeded))


def control(a):
    name = a["device"]
    prof = profile(name)
    if prof.get("type") not in {"joint", "dexterous_hand"}:
        raise ValueError("servo requires a joint or dexterous_hand device")
    if a.get("frame") is not None and a.get("pose") is None:
        raise ValueError("frame requires a pose goal")
    joints = prof["resolved_model"]["joints"]
    state = read(name)
    check_limits = prof["intrinsics"]["control"].get("limit_handling") != "native"
    start = joint_target(state["positions"], joints, check_limits=check_limits)
    goal = joint_target(goal_joints(a, name, prof, start), joints, check_limits=check_limits)
    if "max_joint_delta" in a:
        check_travel(joints, start, goal, a["max_joint_delta"])
    plan = trajectory(joints, start, goal, 0.01,
                      a.get("speedFraction", 1.0), a.get("max_velocity"), a.get("max_acceleration"),
                      check_limits=check_limits)
    outcome = device(name, "write", actions=plan.actions, duration_s=plan.duration_s)["data"]
    return {"device": name, "execution_id": outcome["execution_id"], "joints": goal,
            "duration_s": plan.duration_s, "actions_submitted": len(plan.actions)}


if __name__ == "__main__":
    finish(control(args()))
