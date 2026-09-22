#!/usr/bin/env python3
"""Drive a velocity device: hold a velocity, cover a displacement, or close on a point."""

import math

from kinex import args, finish, profile
from kinex.control import point_in, read, run, stamp
from kinex.geometry import compose_rt, invert_rt, mat_to_quat, quat_to_mat

# Seconds over which a remaining displacement is aimed away. The result is always
# clamped to the preset's declared bounds, so this only sets how gently it closes.
APPROACH_S = 1.5
# The planar axes a displacement is expressed in.
PLANAR = {"x": "vx", "y": "vy", "yaw": "wz"}


def preset(prof, name):
    modes = (prof["intrinsics"]["control"] or {}).get("modes") or {}
    if name not in modes:
        raise ValueError(f"unknown controller preset '{name}'; declared: {', '.join(sorted(modes)) or 'none'}")
    return modes[name]


def channel(spec, name, supplied):
    """Every declared axis of a channel, defaulted and clamped to its bounds."""
    capabilities = spec.get(name)
    if not capabilities:
        return None
    values = {}
    for component in capabilities["components"]:
        axis, limits = component["axis"], component["bounds"]
        fallback = component.get("default") if name == "posture" else 0.0
        value = (supplied or {}).get(axis)
        value = (0.0 if fallback is None else fallback) if value is None else value
        values[axis] = min(max(float(value), limits["min"]), limits["max"])
    return values


def payload(spec, mode, velocity=None, posture=None):
    built = {"mode": mode}
    for key, supplied in (("velocity", velocity), ("posture", posture)):
        values = channel(spec, key, supplied)
        if values is not None:
            built[key] = values
    return built


def evidence(prof, state):
    """Which measurement a displacement can be judged against."""
    feedback = prof["intrinsics"]["feedback"]
    if feedback.get("pose_frame") is not None and state.get("pose") is not None:
        return "pose_feedback"
    return "measured_velocity" if feedback.get("velocity_components") else "dead_reckoning"


def as_rt(pose):
    return quat_to_mat(pose["rotation_xyzw"]), list(pose["translation_m"])


def since(start, pose):
    """Movement since `start`, expressed in the body frame it started in."""
    rt = compose_rt(invert_rt(as_rt(start)), as_rt(pose))
    q = mat_to_quat(rt[0])
    return {"x": rt[1][0], "y": rt[1][1], "yaw": 2 * math.atan2(q[2], q[3])}


def bearing(point, stop_m, axes):
    """A located point in the body frame, as a displacement left to cover."""
    distance = math.hypot(point[0], point[1])
    if "vy" in axes:
        # Able to strafe: close on the point directly, no turn needed.
        scale = 0.0 if distance <= 1e-9 else max(0.0, distance - stop_m) / distance
        return {"x": point[0] * scale, "y": point[1] * scale, "yaw": 0.0}
    return {"x": distance - stop_m, "y": 0.0, "yaw": math.atan2(point[1], point[0])}


def control(a):
    name = a["device"]
    prof = profile(name)
    if prof.get("type") != "velocity":
        raise ValueError("drive requires type velocity")
    spec, mode = preset(prof, a["mode"]), a["mode"]
    hold = a.get("duration_s")
    tolerance_m, tolerance_rad = a.get("tolerance_m", 0.05), a.get("tolerance_rad", 0.05)
    axes = {c["axis"] for c in (spec.get("velocity") or {"components": []})["components"]}

    first = read(name)
    start, reference = first.get("pose"), evidence(prof, first)
    moved = {"x": 0.0, "y": 0.0, "yaw": 0.0}
    track = {"stamp": stamp(first), "commanded": {}, "remaining": None}

    goal = None
    if a.get("displacement") is not None:
        goal = {key: float(a["displacement"].get(key, 0.0)) for key in PLANAR}
    elif a.get("observation") is not None:
        point = point_in(name, a["observation"], a.get("frame"))
        if point is None:
            raise ValueError("the observation located nothing; track decides what to do about a miss")
        goal = bearing(point, a.get("stop_distance_m", 0.5), axes)

    def observe(state):
        """Advance the displacement estimate using the evidence available."""
        now = stamp(state)
        if reference == "pose_feedback":
            moved.update(since(start, state["pose"]))
        else:
            step = max(0.0, now - track["stamp"])
            source = (dict(zip(prof["intrinsics"]["feedback"]["velocity_components"], state.get("velocities") or []))
                      if reference == "measured_velocity" else track["commanded"])
            for key, axis in PLANAR.items():
                moved[key] += source.get(axis, 0.0) * step
        track["stamp"] = now

    def target(rounds, state):
        if state is not None:
            observe(state)
        if hold is not None:
            return payload(spec, mode, a.get("velocity"), a.get("posture"))
        left = {key: goal[key] - moved[key] for key in PLANAR}
        track["remaining"] = left
        return payload(spec, mode, {axis: left[key] / APPROACH_S for key, axis in PLANAR.items()},
                       a.get("posture"))

    def write(command):
        track["commanded"] = command.get("velocity") or {}
        if hold is None:
            left = track["remaining"] or {}
            # The device cannot judge arrival for us: displacement is our estimate.
            arrived = math.hypot(left["x"], left["y"]) <= tolerance_m and abs(left["yaw"]) <= tolerance_rad
            if arrived:
                command = payload(spec, mode, None, a.get("posture"))
        return {name: command}

    budget = hold if hold is not None else a["timeout_s"]
    outcome = run(name, prof, target=target, write=write, until=a.get("until"),
                  timeout_s=budget, on_timeout=a.get("on_timeout", "stop"))
    final = read(name)
    observe(final)
    reason = "fault" if final["faults"] else outcome["terminated_by"]
    result = {"terminated_by": reason, "rounds": outcome["rounds"],
              "elapsed_s": round(outcome["elapsed_s"], 4), "state": final}
    if hold is None:
        left = {key: goal[key] - moved[key] for key in PLANAR}
        reached = math.hypot(left["x"], left["y"]) <= tolerance_m and abs(left["yaw"]) <= tolerance_rad
        result.update(reached=reached, terminated_by="reached" if reached and reason != "fault" else reason,
                      reference=reference,
                      arrival="observed" if reference == "pose_feedback" else "estimated",
                      travelled={k: round(v, 4) for k, v in moved.items()},
                      remaining={k: round(v, 4) for k, v in left.items()})
    else:
        result["reached"] = reason in ("reached", "timeout")
    return result


if __name__ == "__main__":
    finish(control(args()))
