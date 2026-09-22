#!/usr/bin/env python3
"""End-effector driver: complete the vendor hooks; constants live in profile.yaml."""

import sys
from pathlib import Path
from kinex.driver_protocol import run, release
from kinex.scalar_control import command, reading, stopped
from kinex.validation import settings

HERE = Path(__file__).parent
HANDLE = None
PROFILE = None


# Vendor hooks. Lifecycle and reads must not command motion.
def connect(profile):
    raise NotImplementedError("Start owned services and connect using access.connection; wait for readiness and roll back failed startup")


def disconnect(handle):
    raise NotImplementedError("Release the connection and owned services; leave shared external services running")


def read_state(handle, profile):
    raise NotImplementedError("Return positions, velocities, faults, acquisition time and supported sensors")


def send_target(handle, value, profile):
    # value contains validated/quantized target and, when supported, native_speed.
    # Execute the goal for for_s of your own clock, then report elapsed_s,
    # reached and the resulting state.
    raise NotImplementedError("Submit the command without waiting for arrival")


def halt(handle, profile):
    raise NotImplementedError("Perform exactly the stop behavior/scope declared in the profile")


def ensure_handle(profile):
    global HANDLE, PROFILE
    if HANDLE is None:
        HANDLE = connect(profile)
        if HANDLE is None:
            raise RuntimeError("connect must return a ready handle")
        PROFILE = profile
    return HANDLE


def close(stop=True):
    global HANDLE, PROFILE
    handle, HANDLE = HANDLE, None
    profile, PROFILE = PROFILE, None
    if handle is not None:
        release(lambda: halt(handle, profile) if stop else None, lambda: disconnect(handle))


def execute(action, args):
    if action == "unload":
        if HANDLE is None and "--serve" not in sys.argv:
            ensure_handle(settings(HERE))
        close()
        return {"unloaded": True}
    if action == "status":
        return {"connected": HANDLE is not None}
    profile = PROFILE if PROFILE is not None else settings(HERE)
    if action == "load":
        ensure_handle(profile)
        return {"loaded": True}
    if action == "read":
        return reading(profile, read_state(ensure_handle(profile), profile))
    if action == "write":
        value = command(profile, args)
        send_target(ensure_handle(profile), value, profile)
        return {"accepted": True, **value}
    if action == "stop":
        result = stopped(profile)
        halt(ensure_handle(profile), profile)
        return result
    raise ValueError(f"Unsupported end-effector action: {action}")


def handle(action, args):
    try:
        return {"ok": True, **execute(action, args)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def main():
    run(handle, lambda: close(stop="--serve" in sys.argv))


if __name__ == "__main__":
    main()
