#!/usr/bin/env python3
"""IMU transport skeleton. Complete the SDK hooks for the declared connection.

read returns angular_velocity (rad/s), linear_acceleration (m/s^2), and
magnetic_field (T) as axis maps or null, plus orientation (unit xyzw) or null.
Values use the declared measurement frame and acceleration quantity. Dispatch
validates and subtracts profile bias; never subtract it in the driver.
"""

from pathlib import Path

import yaml
from kinex.driver_protocol import run


# --- interface hooks: complete these for the interviewed IMU (TODO) -----------


def connect(connection):
    """Open the declared transport; do not zero, tare, or reset orientation."""
    raise NotImplementedError("interface hook: connect() — complete per DEVICE.md")


def disconnect(handle):
    """Release the device."""
    raise NotImplementedError("interface hook: disconnect() — complete per DEVICE.md")


def read_sample(handle):
    """Return supported vector channels as SI axis maps and unsupported channels
    as null. Orientation maps the IMU frame into its declared reference.
    Include numeric timestamp: acquisition time, or receipt time if unavailable. No implicit gravity
    removal; no fabricated pose or magnetic-field data."""
    raise NotImplementedError("interface hook: read_sample() — complete per DEVICE.md")


# --- generic frame (no vendor specifics below this line) ----------------------


HANDLE = None  # whatever connect() returns; reused within one process


def ensure_handle():
    global HANDLE
    if HANDLE is None:
        profile = yaml.safe_load(Path(__file__).with_name("profile.yaml").read_text())
        HANDLE = connect(profile["access"]["connection"])
        if HANDLE is None:
            raise RuntimeError("connect must return a ready handle")
    return HANDLE


def load_hook(args):
    ensure_handle()
    return {"loaded": True}


def unload_hook(args):
    global HANDLE
    handle, HANDLE = HANDLE, None
    if handle is not None:
        disconnect(handle)
    return {"unloaded": True}


def status(args):
    return {"connected": HANDLE is not None}


def read(args):
    return read_sample(ensure_handle())


ACTIONS = {
    "read": read,
    "load": load_hook,
    "unload": unload_hook,
    "status": status,
}


def handle(action, args):
    if args:
        return {"ok": False, "error": "IMU actions accept no arguments"}
    handler = ACTIONS.get(action)
    if handler is None:
        return {"ok": False, "error": f"unknown action {action!r}; have {sorted(ACTIONS)}"}
    try:
        return {"ok": True, **handler(args)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def main():
    run(handle, lambda: unload_hook({}))


if __name__ == "__main__":
    main()
