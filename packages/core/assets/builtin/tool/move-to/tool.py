#!/usr/bin/env python3
"""Reach a fixed joint goal; the device runs the motion and reports its own time."""

from kinex import args, device, finish, profile
from kinex.control import read, stop_all, stop_on_error, predicate
from kinex.frames import pose as frame_pose
from kinex.geometry import compose_rt, pose_to_rt, xyzq_to_rt
from kinex.joint_control import Arrival
from kinex.motion import Motion, flat, pose as unit_pose, vector
from kinex.trajectory import trajectory, at_rest, planning_limits


# Trajectory sampling is a tool choice; the device owns execution cadence.
TRAJECTORY_HZ = 100


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


def goal_joints(a, name, prof):
    if a.get("joints") is not None:
        return a["joints"]
    pose = canonical(a["pose"], a.get("frame"), name)
    return solve(name, prof, pose)


def control(a):
    name = a["device"]
    prof = profile(name)
    if prof.get("type") != "joint":
        raise ValueError("move_to requires type joint; dexterous_hand is excluded")
    if a.get("frame") is not None and a.get("pose") is None:
        raise ValueError("frame requires a pose goal")
    model = prof.get("resolved_model")
    if not isinstance(model, dict) or not model.get("joints"):
        raise ValueError("resolved joint metadata is required")
    joints = model["joints"]
    tolerance = per_joint(a, "joint_tolerance", 0.01, joints)
    quiet = per_joint(a, "quiet_velocity", 0.005, joints)
    arrive = {"joint_tolerance": tolerance, "quiet_velocity": quiet,
              "stable_s": a.get("stable_s", 0.1)}
    motion = Motion(joints, goal_joints(a, name, prof))

    if not prof["intrinsics"]["feedback"]["velocities"]:
        raise ValueError("move_to requires measured velocities for quiet arrival")
    # Resolve all motion settings before replacing current motion.
    limits = planning_limits(joints, a.get("max_velocity"), a.get("max_acceleration"))
    fraction = a.get("speedFraction", 1.0)
    trajectory(joints, motion.goal_joints, motion.goal_joints, 1 / TRAJECTORY_HZ, fraction, *limits)
    until = a.get("until")
    period = until.get("every_s", 1.0) if until else None
    if period is not None and period <= 0:
        raise ValueError("until.every_s must be positive")
    elapsed, rounds, state = 0.0, 0, None
    reason = predicate(until) if until else None
    with stop_on_error([name]):
        while reason is None:
            budget = min(a["timeout_s"] - elapsed, period) if until else a["timeout_s"] - elapsed
            outcome = follow_trajectory(name, joints, motion.goal_joints, arrive, budget, fraction, *limits)
            spent = outcome["elapsed_s"]
            if spent < 0 or spent > budget + 1e-8:
                raise ValueError("motion exceeded its execution budget")
            elapsed, state, rounds = elapsed + spent, outcome["state"], rounds + 1
            if state["faults"]:
                reason = "fault"
            elif until:
                reason = predicate(until)
            if reason is None:
                if outcome["reached"]:
                    reason = "reached"
                elif elapsed >= a["timeout_s"] - 1e-8:
                    reason = "timeout"
                elif spent <= 0:
                    reason = "timeout" if outcome.get("terminated_by") == "timeout" else "stalled"
                elif not until:
                    reason = "timeout"
        result = finalize(name, motion, {"terminated_by": reason, "rounds": rounds,
            "elapsed_s": elapsed, "state": state}, tolerance, quiet)
        if result["terminated_by"] in {"fault", "stalled", "disturbed"}:
            raise RuntimeError(f"{name}: {result['terminated_by']}")
        if result["terminated_by"] != "reached" and reason != "timeout":
            stop_all([name])
        return result


def follow_trajectory(name, joints, target, arrive, budget, fraction, max_velocity=None, max_acceleration=None):
    """Plan above the driver; submit bounded buffers and inspect their snapshots."""
    stop_all([name])
    state, elapsed = read(name), 0.0
    start = state["positions"]
    resting = Arrival(joints, start, arrive)
    ready = resting.sample(state)
    while not ready and elapsed < budget - 1e-9:
        outcome = device(name, "write", actions=[start], freq_hz=10, for_s=budget - elapsed).get("data") or {}
        spent, state = outcome["elapsed_s"], outcome["state"]
        elapsed += spent
        if spent <= 0 and outcome.get("terminated_by") != "timeout":
            raise RuntimeError(f"{name}: stalled")
        ready = resting.sample(state)
        if state["faults"] or outcome.get("terminated_by") == "timeout" or spent <= 0:
            break
    reached = False
    if ready and elapsed < budget - 1e-9:
        if not at_rest(state, len(joints), arrive["quiet_velocity"]):
            raise ValueError("trajectory start is not at rest")
        actions = trajectory(joints, state["positions"], target, 1 / TRAJECTORY_HZ, fraction, max_velocity, max_acceleration)
        arrival = Arrival(joints, target, arrive)
        frequency = TRAJECTORY_HZ
        while elapsed < budget - 1e-9:
            outcome = device(name, "write", actions=actions, freq_hz=frequency, for_s=budget - elapsed).get("data") or {}
            spent, state = outcome["elapsed_s"], outcome["state"]
            elapsed += spent
            if spent <= 0 and outcome.get("terminated_by") != "timeout":
                raise RuntimeError(f"{name}: stalled")
            if state["faults"]:
                break
            complete = outcome["completed_actions"] == len(actions)
            if complete and arrival.sample(state):
                reached = True
                break
            if outcome["terminated_by"] == "timeout" or spent <= 0:
                break
            # Low-rate arrival checks keep SDK cadence and physics inside the device.
            actions, frequency = [target], 10
    if not reached:
        stop_all([name])
    return {"reached": reached, "elapsed_s": elapsed, "state": state,
            "terminated_by": "reached" if reached else "timeout"}


def within(error, tolerance):
    return all(value <= limit for value, limit in zip(error["joints"], tolerance))


def finalize(name, goal, outcome, tolerance, quiet):
    """Re-read after the move: the device's own arrival report is not the last word."""
    final, reason = read(name), outcome["terminated_by"]
    error = goal.errors(final)
    velocities = vector(final.get("velocities"), len(goal.joints), "measured velocities")
    if final["faults"]:
        reason = "fault"
    elif reason == "reached" and (not within(error, tolerance) or
                                  any(abs(v) > limit for v, limit in zip(velocities, quiet))):
        reason = "disturbed"
    return {"reached": reason == "reached", "terminated_by": reason,
            "rounds": outcome["rounds"], "elapsed_s": outcome["elapsed_s"],
            "quiet_verified": True,
            "error": error, "state": final}


if __name__ == "__main__":
    finish(control(args()))
