#!/usr/bin/env python3
"""Force/torque transport adapter. Raw SI axis maps, no profile bias applied.

read -> {force: {x, y, z} or null, torque: {x, y, z} or null,
         sample_time_s: number or null}. Include exactly the declared axes.
The harness validates channels and subtracts profile bias once at dispatch.
"""

from pathlib import Path

import yaml
from kinex.driver_protocol import run


# --- interface hooks: complete these for the interviewed sensor (TODO) --------


def connect(connection):
    """Open the declared connection. Never tare or zero implicitly."""
    raise NotImplementedError("interface hook: connect() — complete per DEVICE.md")


def disconnect(handle):
    """Release the sensor."""
    raise NotImplementedError("interface hook: disconnect() — complete per DEVICE.md")


def read_wrench(handle):
    """Return SI axis maps in the declared measurement frame, torque about
    its origin, with sign acting on measurement.target. Unsupported channels
    are null; include only measured axes. Do not subtract profile bias."""
    raise NotImplementedError("interface hook: read_wrench() — complete per DEVICE.md")


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
    if args:
        raise ValueError("read accepts no arguments")
    return read_wrench(ensure_handle())


ACTIONS = {
    "read": read,
    "load": load_hook,
    "unload": unload_hook,
    "status": status,
}


def handle(action, args):
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
