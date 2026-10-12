#!/usr/bin/env python3
"""Submit a full joint trajectory, optionally waiting its duration on a world clock."""

from kinex import args, device, finish, profile
from kinex.control import read
from kinex.frames import pose as frame_pose
from kinex.geometry import compose_rt, pose_to_rt, xyzq_to_rt
from kinex.joint_control import home_start_tolerance, project_seed
from kinex.motion import flat, joint_target, pose as unit_pose
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
    joints = device(name, "ik", {"pose": unit_pose(pose), "seed": seed}).get("joints")
    if joints is None:
        raise ValueError("ik returned no joints")
    return joints


def goal_joints(a, name, prof, start):
    if a.get("joints") is not None:
        return a["joints"]
    pose = canonical(a["pose"], a.get("frame"), name)
    return solve(name, prof, pose, start)


def control(a):
    extra = a.keys() - {"device", "joints", "pose", "frame", "speedFraction", "max_velocity", "max_acceleration", "block", "world"}
    if extra:
        raise ValueError(f"unsupported servo arguments: {', '.join(sorted(extra))}")
    block = a.get("block", True)
    if not isinstance(block, bool):
        raise ValueError("block must be a boolean")
    world = a.get("world", "world")
    if block:
        clock = profile(world)
        if not clock or clock.get("type") != "world" or not clock.get("loaded"):
            raise ValueError("blocking servo requires a loaded world device")
    name = a["device"]
    prof = profile(name)
    if prof.get("type") not in {"joint", "dexterous_hand"}:
        raise ValueError("servo requires a joint or dexterous_hand device")
    if a.get("frame") is not None and a.get("pose") is None:
        raise ValueError("frame requires a pose goal")
    joints = prof["resolved_model"]["joints"]
    state = read(name)
    check_limits = prof["intrinsics"]["control"].get("limit_handling") != "native"
    start = joint_target(state["positions"], joints, check_limits=False)
    goal = joint_target(goal_joints(a, name, prof, start), joints, check_limits=check_limits)
    plan = trajectory(joints, start, goal, 0.01,
                      a.get("speedFraction", 1.0), a.get("max_velocity"), a.get("max_acceleration"),
                      check_limits=check_limits,
                      start_tolerance=home_start_tolerance(prof, joints, goal))
    outcome = device(name, "write", {"actions": plan.actions, "duration_s": plan.duration_s})
    if block:
        device(world, "wait", {"duration_s": plan.duration_s})
    return {"device": name, "execution_id": outcome["execution_id"], "joints": goal,
            "duration_s": plan.duration_s, "actions_submitted": len(plan.actions)}


if __name__ == "__main__":
    finish(control(args()))
