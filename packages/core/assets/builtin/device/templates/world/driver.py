#!/usr/bin/env python3
"""Real-world monotonic clock."""

import time

from kinex.driver_protocol import check_cancelled, run
from kinex.validation import number


def dispatch(action, args):
    if action == "wait":
        if set(args) != {"duration_s"}:
            raise ValueError("wait requires duration_s")
        duration = number(args["duration_s"], "duration_s")
        if duration < 0:
            raise ValueError("duration_s must be nonnegative")
        start = time.monotonic()
        while (remaining := start + duration - time.monotonic()) > 0:
            check_cancelled()
            time.sleep(min(remaining, 0.05))
        now = time.monotonic()
        return {"ok": True, "time_s": now, "waited_s": now - start}
    if args:
        raise ValueError(f"{action} takes no arguments")
    if action == "read":
        return {"ok": True, "time_s": time.monotonic()}
    if action in {"load", "unload", "status"}:
        return {"ok": True, "loaded": action != "unload"}
    raise ValueError(f"Unsupported world action: {action}")


if __name__ == "__main__":
    run(dispatch, lambda: None)
