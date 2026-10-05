#!/usr/bin/env python3
"""Plan a full joint trajectory and submit it without waiting for arrival."""

from kinex import args, device, finish, profile
from kinex.control import read
from kinex.frames import pose as frame_pose
from kinex.geometry import compose_rt, pose_to_rt, xyzq_to_rt
from kinex.motion import flat, pose as unit_pose
from kinex.trajectory import trajectory


def canonical(pose, frame, name):
    """Re-express a pose given in `frame` in the device's canonical frame."""
    if frame is None:
        return pose
    return flat(compose_rt(pose_to_rt(frame_pose(frame, name)), xyzq_to_rt(unit_pose(pose))))


def solve(name, prof, pose):
    """Hand one pose to the device's IK driver, which verifies it with FK."""
    if not (prof["intrinsics"].get("kinematics") or {}).get("ik"):
        raise ValueError("pose goals require declared IK")
    joints = (device(name, "ik", pose=unit_pose(pose)).get("data") or {}).get("joints")
    if joints is None:
        raise ValueError("ik returned no joints")
    return joints


def goal_joints(a, name, prof):
    if a.get("joints") is not None:
        return a["joints"]
    pose = canonical(a["pose"], a.get("frame"), name)
    return solve(name, prof, pose)


def control(a):
    name = a["device"]
    prof = profile(name)
    if prof.get("type") not in {"joint", "dexterous_hand"}:
        raise ValueError("servo requires a joint or dexterous_hand device")
    if a.get("frame") is not None and a.get("pose") is None:
        raise ValueError("frame requires a pose goal")
    joints = prof["resolved_model"]["joints"]
    goal = goal_joints(a, name, prof)
    state = read(name)
    plan = trajectory(joints, state["positions"], goal, 0.01,
                      a.get("speedFraction", 1.0), a.get("max_velocity"), a.get("max_acceleration"),
                      check_limits=prof["intrinsics"]["control"].get("limit_handling") != "native")
    outcome = device(name, "write", actions=plan.actions, duration_s=plan.duration_s)["data"]
    return {"device": name, "execution_id": outcome["execution_id"], "joints": goal,
            "duration_s": plan.duration_s, "actions_submitted": len(plan.actions)}


if __name__ == "__main__":
    finish(control(args()))
