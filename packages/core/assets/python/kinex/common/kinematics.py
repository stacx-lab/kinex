"""URDF link forward kinematics and Levenberg-Marquardt IK with a bounded seed search;
standard library only.

The search stays near the seed, so a solution never asks for a distant posture. When it
fails, a bounded probe from seeds spread over the joint ranges says why: the target is
reachable only by a posture change (that posture is reported, and returned only when the
caller asks for a global search), or no solution was found."""

import hashlib
import json
import math
import random
from dataclasses import dataclass
from time import monotonic

from kinex.common.geometry import apply_rt, compose_rt, flat, invert_rt, mat_to_quat, number, quat_to_mat, vector, xyzq_to_rt
from kinex.common.urdf import displacement, joint_target

# Solver policy; the tolerances bound the verified FK residual of an accepted solution.
DEFAULTS = {"position_tolerance_m": 1e-4, "rotation_tolerance_rad": 1e-3, "max_iterations": 200, "damping": .01}
# Goal and search options beyond the solver policy.
GOALS = ("search", "free_axis", "position_only")
SEARCHES = ("local", "global")
# A failure whose closest pose misses the target position by more than this is out of reach.
OUT_OF_REACH_M = .01


class IKError(ValueError):
    """No solution near the seed. details: reason (posture_change, out_of_reach or not_found),
    the closest pose's position_error_m and rotation_error_rad and its best_joints by name, the
    search statistics, and for posture_change the alternative_joints and their travel_rad."""

    def __init__(self, message, details):
        super().__init__(message)
        self.details = details


def cross(a, b):
    return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]


def rotation_error(target, current):
    q = mat_to_quat(compose_rt(xyzq_to_rt(target), invert_rt(xyzq_to_rt(current)))[0])
    length = math.hypot(*q[:3])
    if length < 1e-12:
        return [0.0]*3
    angle = 2*math.atan2(length, abs(q[3])) * (1 if q[3] >= 0 else -1)
    return [v*angle/length for v in q[:3]]


def solve(matrix, value):
    """Solve the small positive-definite damped task-space system."""
    rows = [list(row) + [v] for row, v in zip(matrix, value, strict=True)]
    for i in range(len(rows)):
        pivot = max(range(i, len(rows)), key=lambda j: abs(rows[j][i]))
        rows[i], rows[pivot] = rows[pivot], rows[i]
        scale = rows[i][i]
        rows[i] = [v/scale for v in rows[i]]
        for j in range(len(rows)):
            if j != i:
                factor = rows[j][i]
                rows[j] = [a - factor*b for a, b in zip(rows[j], rows[i], strict=True)]
    return [row[-1] for row in rows]


def reached(options, position, rotation):
    return position <= options["position_tolerance_m"] and rotation <= options["rotation_tolerance_rad"]


DEFAULT_BUDGET = {"max_attempts": 5, "attempt_time_s": 0.02, "max_time_s": 0.1}
# The global probe after a failed local search: seeds spread over the joint ranges.
DEFAULT_GLOBAL_BUDGET = {"global_attempts": 32, "global_time_s": 0.2}


def budget_options(options):
    search = options.get("budget", {})
    if not isinstance(search, dict) or search.keys() - DEFAULT_BUDGET.keys() - DEFAULT_GLOBAL_BUDGET.keys():
        raise ValueError("IK budget requires max_attempts, attempt_time_s, max_time_s, global_attempts and "
                         "global_time_s options only")
    result = {**DEFAULT_BUDGET, **DEFAULT_GLOBAL_BUDGET, **search}
    for key in ("max_attempts", "global_attempts"):
        attempts = result[key]
        if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts <= 0:
            raise ValueError(f"IK budget.{key} must be a positive integer")
    for key in ("attempt_time_s", "max_time_s", "global_time_s"):
        if number(result[key], f"IK budget.{key}") <= 0:
            raise ValueError(f"IK budget.{key} must be positive")
    return result


@dataclass
class Progress:
    iterations: int = 0
    best_score: float = math.inf
    position_error_m: float | None = None
    rotation_error_rad: float | None = None
    best_joints: list | None = None

    def observe(self, position, rotation, options, q=None):
        self.iterations += 1
        score = (position / options["position_tolerance_m"])**2 + (rotation / options["rotation_tolerance_rad"])**2
        if score < self.best_score:
            self.best_score = score
            self.position_error_m, self.rotation_error_rad = position, rotation
            self.best_joints = None if q is None else list(q)


def seeds(joints, targets, original, count):
    """Perturb the original seed locally; retries never expand or wander."""
    yield list(original)
    payload = json.dumps([targets, original], separators=(",", ":"), allow_nan=False)
    rng = random.Random(hashlib.sha256(payload.encode()).digest())
    for _ in range(1, count):
        candidate = []
        for joint, value in zip(joints, original, strict=True):
            limits = joint["limits"]
            radius = (limits["max"] - limits["min"]) * 0.05 if joint["type"] == "prismatic" else 0.35
            q = value + rng.uniform(-radius, radius)
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
    settings = budget_options(options)
    original = list(joint_target(original, joints))
    started = monotonic()
    deadline = started + settings["max_time_s"]
    progress = Progress()
    best, best_distance, attempts = None, math.inf, 0
    for seed in seeds(joints, targets, original, settings["max_attempts"]):
        if monotonic() >= deadline:
            break
        attempts += 1
        until = min(deadline, monotonic() + settings["attempt_time_s"])
        candidate = attempt(seed, until, progress)
        if candidate is None:
            continue
        candidate = joint_target(nearest_representation(joints, joint_target(candidate, joints), original), joints)
        valid = verify(candidate)
        if not valid:
            continue
        score = distance(joints, candidate, original)
        if score < best_distance:
            best, best_distance = candidate, score
        if score == 0:
            break
    if best is not None:
        return {"joints": best}
    reason = "time budget" if monotonic() >= deadline else "attempt budget"
    position = progress.position_error_m
    rotation = progress.rotation_error_rad
    elapsed_ms = (monotonic()-started)*1000
    raise IKError(
        f"IK search exhausted ({reason}); seeds_attempted={attempts}, iterations={progress.iterations}, "
        f"elapsed_ms={elapsed_ms:.3f}, "
        f"position_error_m={position if position is not None else 'unavailable'}, "
        f"rotation_error_rad={rotation if rotation is not None else 'unavailable'}",
        {"reason": "not_found", "budget": reason.split()[0], "seeds_attempted": attempts,
         "iterations": progress.iterations, "elapsed_ms": elapsed_ms, "position_error_m": position,
         "rotation_error_rad": rotation, "best_joints": progress.best_joints})


def spread_seeds(joints, targets, count):
    """Deterministic seeds spread over each joint's range, one turn wide at most for rotary joints."""
    payload = json.dumps(["spread", targets], separators=(",", ":"), allow_nan=False)
    rng = random.Random(hashlib.sha256(payload.encode()).digest())
    for _ in range(count):
        candidate = []
        for joint in joints:
            limits = joint["limits"]
            low, high = (limits["min"], limits["max"]) if limits else (-math.pi, math.pi)
            if joint["type"] != "prismatic" and high - low > math.tau:
                middle = (low + high) / 2
                low, high = middle - math.pi, middle + math.pi
            candidate.append(rng.uniform(low, high))
        yield candidate


def probe(joints, options, targets, original, extra, attempt, verify):
    """The verified solution nearest the seed from spread seeds (extra ones first), within the
    global budget, and the probe's own closest pose; the solution is None when none verified."""
    settings = budget_options(options)
    original = list(joint_target(original, joints))
    deadline = monotonic() + settings["global_time_s"]
    progress = Progress()
    best, best_distance, attempts = None, math.inf, 0
    for seed in [*extra, *spread_seeds(joints, targets, settings["global_attempts"])]:
        if monotonic() >= deadline or attempts >= settings["global_attempts"]:
            break
        attempts += 1
        until = min(deadline, monotonic() + settings["attempt_time_s"])
        candidate = attempt(list(joint_target(seed, joints, check_limits=False)), until, progress)
        if candidate is None:
            continue
        candidate = joint_target(nearest_representation(joints, joint_target(candidate, joints), original), joints)
        if not verify(candidate):
            continue
        score = distance(joints, candidate, original)
        if score < best_distance:
            best, best_distance = candidate, score
    return best, progress


def explain(error, found, progress, joints, original):
    """The local failure as IKError, with what the probe found: a distant posture, or how close any
    seed came to the target."""
    names = [joint["name"] for joint in joints]
    details, message = dict(error.details), str(error)
    if details.get("best_joints") is not None:
        details["best_joints"] = dict(zip(names, details["best_joints"]))
    if found is not None:
        travel = {name: q - start for name, q, start in zip(names, found, original)}
        largest = sorted(travel.items(), key=lambda item: -abs(item[1]))[:3]
        details.update(reason="posture_change", alternative_joints=dict(zip(names, found)), travel_rad=travel)
        message += ("; reachable only by a posture change (" + ", ".join(f"{name} {delta:+.2f} rad" for name, delta in largest)
                    + "); details.alternative_joints has it, and search='global' returns it")
        return IKError(message, details)
    closest = [(details.get("position_error_m"), details.get("rotation_error_rad"))]
    closest.append((progress.position_error_m, progress.rotation_error_rad))
    position, rotation = min((c for c in closest if c[0] is not None), default=(None, None),
                             key=lambda c: (c[0], c[1]))
    reason = "out_of_reach" if position is not None and position > OUT_OF_REACH_M else "not_found"
    details.update(reason=reason, closest_position_error_m=position, closest_rotation_error_rad=rotation)
    if position is not None:
        message += (f"; {'out of reach: ' if reason == 'out_of_reach' else ''}no solution within the joint limits; "
                    f"the closest pose misses by {position:.4f} m and {rotation:.4f} rad")
    return IKError(message, details)


class Chain:
    """The URDF joints from the base link to one link."""

    def __init__(self, tree, link):
        parents = {joint["child"]: joint for joint in tree["joints"]}
        path = []
        while link != tree["base_link"]:
            if link not in parents:
                raise ValueError(f"{link!r} is not a link below {tree['base_link']!r}")
            path.append(parents[link])
            link = parents[link]["parent"]
        self.path = path[::-1]
        self.joints = [joint for joint in self.path if joint["type"] != "fixed"]

    def forward(self, positions):
        """Link pose in the base frame, with each movable joint's axis and origin there."""
        current, axes = xyzq_to_rt([0, 0, 0, 0, 0, 0, 1]), []
        for joint in self.path:
            current = compose_rt(current, xyzq_to_rt(joint["origin"]))
            if joint["type"] == "fixed":
                continue
            axes.append((apply_rt((current[0], [0, 0, 0]), joint["axis"]), list(current[1])))
            current = compose_rt(current, displacement(joint, positions[joint["name"]]))
        return current, axes

    def system(self, target, q, goal=None):
        """Task-space Jacobian rows, residual and position/rotation errors at q. goal None matches the
        full pose; ("axis", a) only aligns the link-frame unit axis a with the target's, leaving rotation
        about it free; ("position",) ignores rotation."""
        current, axes = self.forward({joint["name"]: value for joint, value in zip(self.joints, q, strict=True)})
        current = flat(current)
        linear = [a - b for a, b in zip(target[:3], current[:3], strict=True)]
        columns = [axis + [0, 0, 0] if joint["type"] == "prismatic" else
                   cross(axis, [current[i] - origin[i] for i in range(3)]) + axis
                   for joint, (axis, origin) in zip(self.joints, axes, strict=True)]
        rows = [[column[k] for column in columns] for k in range(6)]
        if goal is not None and goal[0] == "position":
            return rows[:3], linear, math.hypot(*linear), 0.0
        angular = rotation_error(target, current) if goal is None else axis_error(target, current, goal[1])
        return rows, linear + angular, math.hypot(*linear), math.hypot(*angular)

    def attempt(self, target, options, seed, deadline, progress, goal=None):
        """Levenberg-Marquardt from seed: options["damping"] starts the damping, which falls after a
        step that lowers the residual and rises after one that does not (that step is rejected).
        A joint at a limit that the step would push outward stays put for that step."""
        q = list(seed)
        bounds = [(j["limits"]["min"], j["limits"]["max"]) if j["limits"] else (-math.inf, math.inf) for j in self.joints]
        steps = [(hi-lo)*0.05 if math.isfinite(hi-lo) else math.pi*0.05 for lo, hi in bounds]
        rows, residual, position, rotation = self.system(target, q, goal)
        cost, damping = sum(v*v for v in residual), options["damping"]
        for _ in range(options["max_iterations"]):
            if monotonic() >= deadline:
                return None
            progress.observe(position, rotation, options, q)
            if reached(options, position, rotation):
                return q
            gradient = [sum(row[i]*error for row, error in zip(rows, residual, strict=True)) for i in range(len(q))]
            free = [i for i, (v, g, (lo, hi)) in enumerate(zip(q, gradient, bounds, strict=True))
                    if not (v <= lo and g < 0 or v >= hi and g > 0)]
            if not free:
                return None
            matrix = [[sum(row[i]*row[j] for row in rows) + (damping**2 if i == j else 0) for j in free] for i in free]
            delta = [0.0] * len(q)
            for i, d in zip(free, solve(matrix, [gradient[i] for i in free]), strict=True):
                delta[i] = d
            scale = max(1.0, *(abs(d)/step for d, step in zip(delta, steps, strict=True)))
            trial = [max(lo, min(hi, v + d/scale)) for v, d, (lo, hi) in zip(q, delta, bounds, strict=True)]
            trial_system = self.system(target, trial, goal)
            trial_cost = sum(v*v for v in trial_system[1])
            if trial_cost < cost:
                q, (rows, residual, position, rotation), cost = trial, trial_system, trial_cost
                damping = max(damping / 3, 1e-6)
            else:
                damping = min(damping * 4, 10.0)
        return None

    def ik(self, target, seed, options, extra_seeds=()):
        """Positions by name of the chain joints placing the link at target, nearest the seed
        positions by name, within the search budget.

        The search stays near the seed. When it fails, a probe from extra_seeds (positions by
        name, such as a declared home) and seeds spread over the joint ranges explains the
        failure as an IKError; with options search="global" the probe's solution nearest the
        seed is returned instead. free_axis or position_only relax the goal (goal_options)."""
        if not self.joints or any(joint["mimic"] for joint in self.joints):
            raise ValueError("IK requires a link reached through independent movable joints")
        iterations = options["max_iterations"]
        if isinstance(iterations, bool) or not isinstance(iterations, int) or iterations <= 0:
            raise ValueError("IK max_iterations must be a positive integer")
        for key in ("damping", "position_tolerance_m", "rotation_tolerance_rad"):
            if number(options[key], f"IK {key}") <= 0:
                raise ValueError(f"IK {key} must be positive")
        mode, goal = goal_options(options)
        budget_options(options)  # validated before any attempt runs

        def attempt(q, deadline, progress):
            return self.attempt(target, options, q, deadline, progress, goal=goal)

        def verify(q):
            return reached(options, *self.system(target, q, goal)[2:])

        original = [seed[joint["name"]] for joint in self.joints]
        try:
            solved = search(self.joints, options, [target], original, attempt, verify)["joints"]
        except IKError as error:
            extra = [[values[joint["name"]] for joint in self.joints] for values in extra_seeds
                     if all(joint["name"] in values for joint in self.joints)]
            found, progress = probe(self.joints, options, [target], original, extra, attempt, verify)
            if found is None or mode == "local":
                raise explain(error, found, progress, self.joints,
                              list(joint_target(original, self.joints))) from None
            solved = found
        return {joint["name"]: value for joint, value in zip(self.joints, solved)}


def goal_options(options):
    """The search scope and relaxed goal: search is "local" (default) or "global"; free_axis is a
    unit axis in the link frame about which rotation is free, such as a gripper's approach axis;
    position_only ignores rotation."""
    mode = options.get("search", "local")
    if mode not in SEARCHES:
        raise ValueError("IK search must be 'local' or 'global'")
    axis, position_only = options.get("free_axis"), options.get("position_only", False)
    if not isinstance(position_only, bool):
        raise ValueError("IK position_only must be true or false")
    if axis is not None and position_only:
        raise ValueError("IK takes free_axis or position_only, not both")
    if position_only:
        return mode, ("position",)
    if axis is None:
        return mode, None
    axis = vector(axis, 3, "IK free_axis")
    norm = math.hypot(*axis)
    if not norm > 1e-9:
        raise ValueError("IK free_axis must be a nonzero axis")
    return mode, ("axis", [v / norm for v in axis])


def axis_error(target, current, axis):
    """The rotation vector turning the current link axis onto the target's, in the base frame: rotation
    about the axis itself is free."""
    have = apply_rt((quat_to_mat(current[3:7]), [0, 0, 0]), axis)
    want = apply_rt((quat_to_mat(target[3:7]), [0, 0, 0]), axis)
    normal = cross(have, want)
    sine, cosine = math.hypot(*normal), sum(a*b for a, b in zip(have, want))
    angle = math.atan2(sine, cosine)
    if sine > 1e-12:
        return [v * angle / sine for v in normal]
    if cosine > 0:
        return [0.0] * 3
    # Opposite axes: turn half a revolution about any perpendicular.
    other = cross(have, [1, 0, 0] if abs(have[0]) < .9 else [0, 1, 0])
    length = math.hypot(*other)
    return [v * math.pi / length for v in other]
