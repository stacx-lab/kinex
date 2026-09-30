#!/usr/bin/env python3
"""RGBD camera driver skeleton. Setup: DEVICE.md. Contract: DEVICE.md#use.

Complete the four source hooks; shared capture code validates and encodes output.
"""

import pathlib
import threading
from copy import deepcopy
import sys
from kinex.driver_protocol import run, release
from kinex.capture import settings, validate, save

HERE = pathlib.Path(__file__).parent
OUT = HERE / "out"
SOURCE_LOCK = threading.RLock()

STREAM = None  # whatever open_stream() returns; reused within one process
RECORDER = None  # kinex.stream.VideoRecorder while recording


# --- SDK hooks: complete these for the interviewed camera (TODO) -------------


def open_stream():
    """Open the device and start color+depth streaming; return an SDK handle.
    Request depth ALIGNED to the color pixel grid whenever the SDK offers it
    (e.g. pyrealsense2: rs.align(rs.stream.color)); warm auto-exposure by
    dropping a few frames before the first real grab."""
    # Start owned streaming services, wait for readiness; undo partial startup on failure.
    raise NotImplementedError("SDK hook: open_stream() — complete per DEVICE.md")


def grab(stream):
    """Return {color: HxWx3 uint8 RGB, sample_time_s: acquisition Unix seconds,
    depth: HxW uint16 in profile units, depth_sample_time_s: acquisition Unix seconds}.
    Read the output geometry and connection from settings(HERE)."""
    raise NotImplementedError("SDK hook: grab() — complete per DEVICE.md")


def close_stream(stream):
    """Stop streaming and owned services; release the device even on failure."""
    raise NotImplementedError("SDK hook: close_stream() — complete per DEVICE.md")


def introspect(args):
    """Return a profile patch: intrinsics.color and (RGBD) intrinsics.depth,
    extrinsics.depth_to_color for native depth. Match the active output mode;
    report explicit projection/distortion models, scale and timestamp calibration.
    Unsupported vendor models must be rectified using the SDK."""
    raise NotImplementedError("SDK hook: introspect() — complete per DEVICE.md")


# --- generic frame (no SDK specifics below this line) ------------------------


def ensure_stream():
    global STREAM
    if STREAM is None:
        STREAM = open_stream()
        if STREAM is None:
            raise RuntimeError("open_stream must return a ready handle")
    return STREAM


def latest_frameset():
    """The frameset to serve: the capture thread's latest while streaming (never
    a second grab() on a busy device), otherwise one fresh grab()."""
    recorder = RECORDER
    if recorder is None:
        return sample(ensure_stream())
    frameset = recorder.wait_latest()
    if frameset is None:
        raise RuntimeError(f"recorder has no frame yet: {recorder.error or 'still warming up'}")
    return frameset


def sample(stream):
    # SDK grabs may reuse buffers; publish an owned snapshot before releasing it.
    with SOURCE_LOCK:
        return deepcopy(validate(settings(HERE), grab(stream)))


def read(args):
    return save(settings(HERE), latest_frameset(), OUT)


def load_hook(args):
    ensure_stream()
    return {"loaded": True}


def unload_hook(args):
    def disconnect():
        global STREAM
        if RECORDER is not None and RECORDER.running:
            raise RuntimeError("capture still uses the stream; process teardown is required")
        stream, STREAM = STREAM, None
        if stream is not None:
            close_stream(stream)
    release(lambda: record_stop(args), disconnect)
    return {"unloaded": True}


def status(args):
    return {"streaming": STREAM is not None, "recording": RECORDER.facts() if RECORDER is not None else None}


def record_start(args):
    """Start continuous capture; returns current capture facts."""
    global RECORDER
    from kinex.stream import VideoRecorder

    if RECORDER is not None:
        print("record_start: closing stale recording", file=sys.stderr)
        record_stop(args)
    stream = ensure_stream()
    RECORDER = VideoRecorder(
        lambda: sample(stream), args["dir"],
        rate_hz=args.get("rate_hz") or 15, fps=args.get("fps") or 15, max_px=args.get("max_px"),
        image=lambda frameset: frameset["color"], depth=lambda frameset: frameset["depth"],
    )
    RECORDER.start()
    return RECORDER.facts()


def record_stop(args):
    """Close capture and return its products, timing and errors."""
    global RECORDER
    if RECORDER is None:
        return {"file": None, "frames": 0}
    latest = RECORDER.latest
    recorder = RECORDER
    result = recorder.stop()
    RECORDER = None
    if latest is not None:
        result["depth_scale"] = settings(HERE)["intrinsics"]["depth"]["scale_m_per_unit"]
    return result


ACTIONS = {
    "read": read,
    "load": load_hook,
    "unload": unload_hook,
    "status": status,
    "introspect": introspect,
    "record_start": record_start,
    "record_stop": record_stop,
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
