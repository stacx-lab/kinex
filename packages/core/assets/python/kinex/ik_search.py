"""Bounded, deterministic seed search for the standard-library DLS solver."""

import hashlib
import json
import math
import random
from dataclasses import dataclass
from time import monotonic

from kinex.driver_protocol import check_cancelled
from kinex.motion import joint_target
from kinex.validation import number


DEFAULT_SEARCH = {"max_attempts": 5, "attempt_time_s": 0.02, "max_time_s": 0.1}


def search_options(options):
    search = options.get("search", {})
    if not isinstance(search, dict) or search.keys() - DEFAULT_SEARCH.keys():
        raise ValueError("IK search requires max_attempts, attempt_time_s and max_time_s options only")
    result = {**DEFAULT_SEARCH, **search}
    attempts = result["max_attempts"]
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts <= 0:
        raise ValueError("IK search.max_attempts must be a positive integer")
    for key in ("attempt_time_s", "max_time_s"):
        if number(result[key], f"IK search.{key}") <= 0:
            raise ValueError(f"IK search.{key} must be positive")
    return result


def checkpoint(deadline):
    check_cancelled()
    return monotonic() < deadline


@dataclass
class Progress:
    iterations: int = 0
    best_score: float = math.inf
    position_error_m: float | None = None
    rotation_error_rad: float | None = None

    def observe(self, position, rotation, options):
        self.iterations += 1
        score = (position / options["position_tolerance_m"])**2 + (rotation / options["rotation_tolerance_rad"])**2
        if score < self.best_score:
            self.best_score = score
            self.position_error_m, self.rotation_error_rad = position, rotation


def seeds(joints, targets, original, count):
    """A fresh local RNG keeps retries independent of unrelated calls and threads."""
    yield list(original)
    payload = json.dumps([targets, original], separators=(",", ":"), allow_nan=False)
    rng = random.Random(hashlib.sha256(payload.encode()).digest())
    for attempt in range(1, count):
        candidate = []
        for joint, value in zip(joints, original, strict=True):
            limits = joint["limits"]
            if attempt <= 2:
                radius = (limits["max"] - limits["min"]) * 0.05 if joint["type"] == "prismatic" else 0.35
                q = value + rng.uniform(-radius, radius)
            elif limits:
                q = rng.uniform(limits["min"], limits["max"])
            else:
                q = value + rng.uniform(-math.pi, math.pi)
            candidate.append(max(limits["min"], min(limits["max"], q)) if limits else q)
        yield candidate


def nearest_representation(joints, candidate, original):
    """Choose equivalent rotary angles near the seed without crossing limits."""
    result = []
    for joint, q, start in zip(joints, candidate, original, strict=True):
        if joint["type"] == "continuous":
            q = start + math.atan2(math.sin(q-start), math.cos(q-start))
        elif joint["type"] == "revolute":
            limits = joint["limits"]
            lower = math.ceil((limits["min"] - q) / math.tau)
            upper = math.floor((limits["max"] - q) / math.tau)
            turns = max(lower, min(upper, round((start - q) / math.tau)))
            q += turns * math.tau
        result.append(q)
    return result


def distance(joints, candidate, original):
    total = 0.0
    for joint, q, start in zip(joints, candidate, original, strict=True):
        delta = q - start
        if joint["type"] == "continuous":
            delta = math.atan2(math.sin(delta), math.cos(delta))
            width = 2 * math.pi
        else:
            width = joint["limits"]["max"] - joint["limits"]["min"]
        total += (delta / width)**2
    return total


def search(joints, options, targets, original, attempt, verify):
    """Select the nearest verified solution within the existing search budget."""
    settings = search_options(options)
    original = list(joint_target(original, joints))
    started = monotonic()
    deadline = started + settings["max_time_s"]
    progress = Progress()
    best, best_distance, attempts = None, math.inf, 0
    for seed in seeds(joints, targets, original, settings["max_attempts"]):
        if not checkpoint(deadline):
            break
        attempts += 1
        until = min(deadline, monotonic() + settings["attempt_time_s"])
        candidate = attempt(seed, until, progress)
        check_cancelled()
        if candidate is None:
            continue
        candidate = joint_target(nearest_representation(joints, joint_target(candidate, joints), original), joints)
        valid = verify(candidate)
        check_cancelled()
        if not valid:
            continue
        score = distance(joints, candidate, original)
        if score < best_distance:
            best, best_distance = candidate, score
        if score == 0:
            break
    check_cancelled()
    if best is not None:
        return {"joints": best}
    reason = "time budget" if monotonic() >= deadline else "attempt budget"
    position = progress.position_error_m
    rotation = progress.rotation_error_rad
    raise ValueError(
        f"IK search exhausted ({reason}); seeds_attempted={attempts}, iterations={progress.iterations}, "
        f"elapsed_ms={(monotonic()-started)*1000:.3f}, "
        f"position_error_m={position if position is not None else 'unavailable'}, "
        f"rotation_error_rad={rotation if rotation is not None else 'unavailable'}")
