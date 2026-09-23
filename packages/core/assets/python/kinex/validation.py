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


def segment(args, command):
    """Attach a validated duration to a velocity or scalar command."""
    budget = number(args.get("for_s"), "for_s")
    if budget <= 0:
        raise ValueError("for_s must be positive")
    return {**command, "for_s": budget}


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
