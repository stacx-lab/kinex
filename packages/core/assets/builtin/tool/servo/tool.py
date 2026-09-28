#!/usr/bin/env python3
"""Plan a joint trajectory segment and submit it."""

from kinex import args, device, finish, profile
from kinex.control import read
from kinex.frames import pose as frame_pose
from kinex.geometry import compose_rt, pose_to_rt, xyzq_to_rt
from kinex.motion import flat, pose as unit_pose
from kinex.trajectory import trajectory, planning_limits


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
    if prof.get("type") != "joint":
        raise ValueError("servo requires a joint device")
    if a.get("frame") is not None and a.get("pose") is None:
        raise ValueError("frame requires a pose goal")
    joints = prof["resolved_model"]["joints"]
    goal = goal_joints(a, name, prof)
    limits = planning_limits(joints, a.get("max_velocity"), a.get("max_acceleration"))
    state = read(name)
    actions = trajectory(joints, state["positions"], goal, 0.01,
                         a.get("speedFraction", 1.0), *limits, duration_s=a["duration_s"])
    outcome = device(name, "write", actions=actions, duration_s=a["duration_s"])["data"]
    return {"device": name, "joints": goal, "duration_s": a["duration_s"],
            "actions_submitted": len(actions), "write": outcome}


if __name__ == "__main__":
    finish(control(args()))
