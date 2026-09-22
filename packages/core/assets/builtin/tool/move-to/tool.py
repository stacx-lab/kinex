#!/usr/bin/env python3
"""Reach a fixed joint goal; the device runs the motion and reports its own time."""

from kinex import args, device, finish, profile
from kinex.control import read, run, stop_all, stop_on_error, stamp
from kinex.frames import pose as frame_pose
from kinex.geometry import apply_rt, compose_rt, pose_to_rt, xyzq_to_rt
from kinex.joint_control import command as joint_command, JointSamples
from kinex.motion import Motion, flat, pose as unit_pose, vector


def per_joint(a, key, default, joints):
    value = a.get(key, default)
    return vector(value if isinstance(value, list) else [value] * len(joints), len(joints), key)


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


def observed_pose(a, name):
    """An observation's point as a pose goal in the device's canonical frame."""
    observation = a["observation"]
    point = observation.get("point")
    if point is None:
        raise ValueError("the observation located nothing; track decides what to do about a miss")
    point = vector(point, 3, "located point")
    frame = a.get("frame") or observation.get("frame")
    if not frame:
        raise ValueError("the observation names no frame for its point; supply frame")
    if frame != name:
        point = apply_rt(pose_to_rt(frame_pose(frame, name)), point)
    offset = a.get("offset_m") or [0.0, 0.0, 0.0]
    rotation = a.get("orientation")
    if rotation is None:
        # Reaching for a point says nothing about wrist orientation: hold the current one.
        state = read(name)
        rotation = unit_pose((device(name, "fk", joints=state["positions"]).get("data") or {})["pose"])[3:]
    return [p + o for p, o in zip(point, offset)] + list(rotation)


def goal_joints(a, name, prof):
    if a.get("joints") is not None:
        return a["joints"]
    pose = observed_pose(a, name) if a.get("observation") is not None \
        else canonical(a["pose"], a.get("frame"), name)
    return solve(name, prof, pose)


def control(a):
    name = a["device"]
    prof = profile(name)
    if prof.get("type") != "joint":
        raise ValueError("move_to requires type joint; dexterous_hand is excluded")
    if a.get("frame") is not None and a.get("pose") is None and a.get("observation") is None:
        raise ValueError("frame requires a pose or observation goal")
    model = prof.get("resolved_model")
    if not isinstance(model, dict) or not model.get("joints"):
        raise ValueError("resolved joint metadata is required")
    joints = model["joints"]
    tolerance = per_joint(a, "joint_tolerance", 0.01, joints)
    quiet = per_joint(a, "quiet_velocity", 0.005, joints)
    # The device decides arrival: it is the only party that sees every control step.
    arrive = {"joint_tolerance": tolerance, "quiet_velocity": quiet,
              "stable_s": a.get("stable_s", 0.1)}
    motion = Motion(joints, goal_joints(a, name, prof))

    payload = {"target": motion.goal_joints, "arrive": arrive, "for_s": a["timeout_s"]}
    if "speedFraction" in a:
        payload["speedFraction"] = a["speedFraction"]
    joint_command(prof, payload, model)
    outcome = run(name, payload, until=a.get("until"), timeout_s=a["timeout_s"],
                  on_timeout=a.get("on_timeout", "stop"))
    continuing = outcome["terminated_by"] == "timeout" and a.get("on_timeout") == "continue"
    with stop_on_error([name] if continuing else []):
        result = finalize(name, motion, outcome, tolerance, quiet, prof)
    if continuing and result["terminated_by"] != "timeout":
        stop_all([name])
    return result


def within(error, tolerance):
    return all(value <= limit for value, limit in zip(error["joints"], tolerance))


def finalize(name, goal, outcome, tolerance, quiet, prof):
    """Re-read after the move: the device's own arrival report is not the last word."""
    final, reason = read(name), outcome["terminated_by"]
    error = goal.errors(final)
    measured = prof["intrinsics"]["feedback"]["velocities"]
    samples = JointSamples(goal.joints, measured)
    previous = outcome["state"]
    if not measured and previous is not None and stamp(previous) < stamp(final):
        samples.sample(previous)
    _, velocities, _ = samples.sample(final)
    quiet_verified = velocities is not None
    if final["faults"]:
        reason = "fault"
    elif reason == "reached" and (not within(error, tolerance) or
                                  (quiet_verified and any(abs(v) > limit for v, limit in zip(velocities, quiet)))):
        reason = "disturbed"
    return {"reached": reason == "reached", "terminated_by": reason,
            "rounds": outcome["rounds"], "elapsed_s": outcome["elapsed_s"],
            "quiet_verified": quiet_verified,
            "error": error, "state": final}


if __name__ == "__main__":
    finish(control(args()))
