#!/usr/bin/env python3
"""Hold one velocity/posture command for a bounded duration."""

from kinex import args, finish, profile
from kinex.control import read, run
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


def control(a):
    name = a["device"]
    prof = profile(name)
    if prof.get("type") != "velocity":
        raise ValueError("drive requires type velocity")
    command = velocity_command(prof, {**payload(prof, a), "for_s": a["duration_s"]})
    outcome = run(name, command, timeout_s=a["duration_s"], until=a.get("until"),
                  finish_when_reached=False)
    final = read(name)
    reason = "fault" if final["faults"] else outcome["terminated_by"]
    if reason == "timeout":
        reason = "duration"
    return {"reached": reason == "duration", "terminated_by": reason,
            "rounds": outcome["rounds"], "elapsed_s": outcome["elapsed_s"], "state": final}


if __name__ == "__main__":
    finish(control(args()))
