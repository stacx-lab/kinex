#!/usr/bin/env python3
"""Hold one velocity/posture command for a bounded duration."""

from kinex import args, device, finish, profile
from kinex.control import read, predicate, stop_all, stop_on_error
from kinex.validation import number, segment_result
from kinex.velocity import command as velocity_command


def payload(prof, a):
    modes = prof["intrinsics"]["control"]["modes"]
    mode = a["mode"]
    if mode not in modes:
        raise ValueError(f"unknown controller preset '{mode}'")
    built = {"mode": mode}
    for channel in ("velocity", "posture"):
        spec, supplied = modes[mode][channel], a.get(channel, {})
        if spec is None:
            if channel in a:
                raise ValueError(f"{channel} is unsupported in this mode")
            continue
        axes = {c["axis"] for c in spec["components"]}
        if set(supplied) - axes:
            raise ValueError(f"undeclared {channel} axes")
        built[channel] = {c["axis"]: supplied.get(c["axis"], c["default"] if channel == "posture" else 0.0)
                          for c in spec["components"]}
    return built


def hold(name, command, duration, until):
    elapsed, rounds, state = 0.0, 0, None
    period = number(until.get("every_s", 1.0), "until.every_s") if until else duration
    if period <= 0:
        raise ValueError("until.every_s must be positive")
    next_check = period
    with stop_on_error([name]):
        reason = predicate(until) if until else None
        while reason is None:
            budget = min(duration, next_check) - elapsed
            outcome = segment_result(device(name, "write", **{**command, "for_s": budget}).get("data"))
            spent, state = outcome["elapsed_s"], outcome["state"]
            if spent > budget + 1e-8:
                raise ValueError("write exceeded its execution budget")
            elapsed, rounds = elapsed + spent, rounds + 1
            if state["faults"]:
                reason = "fault"
            elif until and elapsed + 1e-9 >= min(next_check, duration):
                reason = predicate(until)
                next_check = elapsed + period
            if reason is None:
                if elapsed + 1e-9 >= duration:
                    reason = "duration"
                elif spent <= 0:
                    reason = "stalled"
        if reason in {"fault", "stalled"}:
            raise RuntimeError(f"{name}: {reason}")
    stop_all([name])
    return {"terminated_by": reason, "rounds": rounds, "elapsed_s": elapsed, "state": state}


def control(a):
    name = a["device"]
    prof = profile(name)
    if prof.get("type") != "velocity":
        raise ValueError("drive requires type velocity")
    command = velocity_command(prof, {**payload(prof, a), "for_s": a["duration_s"]})
    outcome = hold(name, command, a["duration_s"], a.get("until"))
    final = read(name)
    if final["faults"]:
        raise RuntimeError(f"{name}: fault")
    reason = outcome["terminated_by"]
    return {"reached": reason == "duration", "terminated_by": reason,
            "rounds": outcome["rounds"], "elapsed_s": outcome["elapsed_s"], "state": final}


if __name__ == "__main__":
    finish(control(args()))
