#!/usr/bin/env python3
"""Check measured joint arrival using a caller-owned predicate state."""

from kinex import args, finish, profile
from kinex.control import read
from kinex.joint_control import Arrival
from kinex.motion import joint_target, vector
from kinex.validation import number


def check(a):
    context = a["context"]
    now = number(context["time_s"], "context.time_s")
    previous = a.get("state") or {}
    if now < previous.get("time_s", now):
        raise ValueError("world clock moved backwards")
    state = {**previous, "started_s": previous.get("started_s", now), "time_s": now}
    timeout = a.get("timeout_s")
    if timeout is not None and now - state["started_s"] >= timeout:
        return {"done": True, "reason": "timeout", "state": state}
    result, values = context.get("control_result") or {}, context.get("control_args") or {}
    name = a.get("device") or result.get("device") or values.get("device")
    goal = a.get("joints", result.get("joints", values.get("joints")))
    if name is None or goal is None:
        state["since_s"] = None
        return {"done": False, "state": state}
    prof = profile(name)
    joints = prof["resolved_model"]["joints"]
    goal = joint_target(goal, joints, check_limits=prof["intrinsics"]["control"].get("limit_handling") != "native")
    if not prof["intrinsics"]["feedback"]["velocities"]:
        raise ValueError("settled requires measured velocities")

    def tolerance(key, default):
        value = a.get(key, default)
        return vector(value if isinstance(value, list) else [value] * len(joints), len(joints), key)

    spec = {"joint_tolerance": tolerance("joint_tolerance", 0.01),
            "quiet_velocity": tolerance("quiet_velocity", 0.005), "stable_s": a.get("stable_s", 0.1)}
    arrival = Arrival(joints, goal, spec)
    if state.get("device") == name:
        arrival.stamp = previous.get("sample_timestamp")
        if arrival.stamp is not None and state.get("joints") == goal:
            arrival.since = state.get("since_s")
    measured = read(name)
    if measured["faults"]:
        raise RuntimeError(f"{name}: device fault")
    done = arrival.sample(measured, time_s=now)
    state.update(device=name, joints=goal, since_s=arrival.since, sample_timestamp=arrival.stamp)
    return {"done": done, "reason": "settled" if done else None, "state": state}


if __name__ == "__main__":
    finish(check(args()))
