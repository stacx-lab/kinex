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
    budget = number(args.get("duration_s"), "duration_s")
    if budget <= 0:
        raise ValueError("duration_s must be positive")
    return {**command, "duration_s": budget}
