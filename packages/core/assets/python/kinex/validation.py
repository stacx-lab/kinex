"""Small shared boundary checks and profile loading for drivers and tools."""

import math
from pathlib import Path


def settings(directory):
    import yaml
    return yaml.safe_load((Path(directory) / "profile.yaml").read_text())


def number(value, name="value"):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return value


def vector(value, size, name="components"):
    if not isinstance(value, list) or len(value) != size:
        raise ValueError(f"{name} needs {size} numbers")
    for entry in value:
        number(entry, name)
    return value


# Every write is a SEGMENT: the device pursues the target and reports how much of
# its own clock it spent. `for_s` bounds that; `arrive` is the arrival spec it
# judges itself against. Command validators pass both through untouched.
SEGMENT = ("for_s", "arrive")


def segment(args, command):
    """Carry the segment fields from `args` onto a validated `command`."""
    for key in SEGMENT:
        if key in args:
            command[key] = args[key]
    if number(command.get("for_s"), "for_s") <= 0:
        raise ValueError("for_s must be positive")
    if "arrive" in command and not isinstance(command["arrive"], dict):
        raise ValueError("arrive must be an object")
    return command


def segment_result(result):
    """Validate a successful write without inventing device timing or feedback."""
    if not isinstance(result, dict) or result.get("accepted") is not True:
        raise ValueError("write must acknowledge accepted: true")
    if number(result.get("elapsed_s"), "write.elapsed_s") < 0:
        raise ValueError("write.elapsed_s must not be negative")
    if not isinstance(result.get("reached"), bool):
        raise ValueError("write.reached must be a boolean")
    state = result.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("faults"), list):
        raise ValueError("write.state must contain a faults list")
    return result
