"""Offline Panda and ARX X5 IK comparison; run separately from CI's correctness tests.

The X5 section samples reachable flange poses and seeds each near its solution (local search
must solve) or anywhere in a turn (the local search fails as a posture change and
search="global" solves), and replays the RLE-Bench traces in fixtures/ik/x5-traces.json.

PYTHONPATH=packages/core/assets/python python3 packages/core/test/benchmark_ik.py --output /tmp/kinex-ik.json
"""

import argparse
import json
import math
from contextlib import ExitStack
from pathlib import Path
import platform
import random
import statistics
from time import perf_counter
from unittest.mock import patch

from kinex.common import kinematics
from kinex.common.geometry import pose_error
from kinex.common.joints import JointModel
from kinex.common.kinematics import budget_options
from kinex.common.urdf import joint_target


FIXTURES = Path(__file__).parent / "fixtures" / "ik"


def summarize(rows):
    values = sorted(row["elapsed_ms"] for row in rows)
    offset = (len(values)-1) * .95
    lo, hi = math.floor(offset), math.ceil(offset)
    return {"count": len(rows), "solved": sum(row["ok"] for row in rows),
            "median_ms": round(statistics.median(values), 3),
            "p95_ms": round(values[lo] + (values[hi]-values[lo]) * (offset-lo), 3),
            "max_ms": round(max(values), 3),
            "mean_attempts": round(statistics.mean(row["attempts"] for row in rows), 2)}


def spread(values):
    values = sorted(values)
    if not values:
        return None
    offset = (len(values)-1) * .95
    lo, hi = math.floor(offset), math.ceil(offset)
    return {"median": round(statistics.median(values), 3), "p95": round(values[lo] + (values[hi]-values[lo]) * (offset-lo), 3),
            "max": round(values[-1], 3)}


def measure(model, options, goal, seed):
    """One IK call: local attempts and iterations, and the failure probe's time and attempts apart."""
    progress, probed = [], {}
    attempt = kinematics.Chain.attempt

    def recorded(*args, **kwargs):
        progress.append(args[-1])
        return attempt(*args, **kwargs)

    with ExitStack() as stack:
        stack.enter_context(patch.object(kinematics.Chain, "attempt", side_effect=recorded, autospec=True))
        if hasattr(kinematics, "probe"):
            probe = kinematics.probe

            def timed(*args):
                mark, start = len(progress), perf_counter()
                try:
                    return probe(*args)
                finally:
                    probed.update(ms=(perf_counter()-start) * 1000, attempts=len(progress)-mark, mark=mark)
            stack.enter_context(patch.object(kinematics, "probe", side_effect=timed))
        start = perf_counter()
        try:
            q = model.ik(goal, seed, **options)
            error = reason = None
        except ValueError as failure:
            if "IK search exhausted" not in str(failure):
                raise
            q, error = None, str(failure)
            reason = getattr(failure, "details", {}).get("reason")
        elapsed = (perf_counter()-start) * 1000
    residual = None
    if q is not None:
        joint_target(q, model.joints)
        residual = pose_error(goal, model.fk(q))
        assert residual["position_m"] <= kinematics.DEFAULTS["position_tolerance_m"]
        assert residual["rotation_rad"] <= kinematics.DEFAULTS["rotation_tolerance_rad"]
    local = progress[:probed.get("mark", len(progress))]
    return {"ok": q is not None, "joints": q, "elapsed_ms": elapsed, "error": error, "reason": reason,
            "residual": residual, "attempts": len(local), "iterations": local[-1].iterations if local else 0,
            "probe_ms": probed.get("ms"), "probe_attempts": probed.get("attempts"),
            "travel_rad": max(abs(a-b) for a, b in zip(seed, q)) if q is not None else None}


def chunk(model, options, sample):
    seed, rows, steps = sample["initial"], [], []
    for goal in sample["goals"]:
        row = measure(model, options, goal, seed)
        rows.append(row)
        if not row["ok"]:
            break
        steps.append(max(abs(a-b) for a, b in zip(seed, row["joints"])))
        seed = row["joints"]
    return {"ok": len(rows) == len(sample["goals"]) and all(row["ok"] for row in rows),
            "elapsed_ms": sum(row["elapsed_ms"] for row in rows),
            "attempts": sum(row["attempts"] for row in rows),
            "prefix": sum(row["ok"] for row in rows), "max_joint_step_rad": max(steps, default=0),
            "waypoints": rows}


def turn(joint):
    limits = joint["limits"]
    low, high = (limits["min"], limits["max"]) if limits else (-math.pi, math.pi)
    if joint["type"] != "prismatic" and high - low > math.tau:
        low, high = (low+high)/2 - math.pi, (low+high)/2 + math.pi
    return low, high


def x5_cases(model, rng, count):
    """Flange poses of random postures within a turn, each with a seed near its posture and one anywhere."""
    for index in range(count):
        q = [rng.uniform(*turn(joint)) for joint in model.joints]
        near = [v + rng.uniform(-.2, .2) for v in q]
        far = [rng.uniform(*turn(joint)) for joint in model.joints]
        yield {"id": index, "goal": model.fk(q), "posture": q, "near": near, "far": far}


def x5(global_search=True, count=100):
    """Local and (when the solver has it) global search on the ARX X5 and its RLE-Bench traces."""
    model = JointModel(json.loads((FIXTURES / "x5.json").read_text()), FIXTURES)
    traces = json.loads((FIXTURES / "x5-traces.json").read_text())["cases"]
    cases = list(x5_cases(model, random.Random(45), count))
    modes = {"local_near": ("near", {}), "local_far": ("far", {})}
    if global_search:
        modes["global_far"] = ("far", {"search": "global"})
    for case in cases[:3]:
        measure(model, {}, case["goal"], case["near"])
    rows = {name: [] for name in modes}
    for case in cases:
        for name, (seed, options) in modes.items():
            row = measure(model, options, case["goal"], case[seed])
            row["posture_travel_rad"] = max(abs(a-b) for a, b in zip(case[seed], case["posture"]))
            rows[name].append({"id": case["id"], **row})
    trace_modes = {"local": {}, **({"global": {"search": "global"}} if global_search else {})}
    trace_rows = [{"id": case["id"], **{name: measure(model, options, case["goal"], case["seed"])
                                        for name, options in trace_modes.items()}} for case in traces]

    def describe(rows):
        failed = [row for row in rows if not row["ok"]]
        return {**summarize(rows), "reasons": {reason: sum(str(row["reason"]) == reason for row in failed)
                                               for reason in sorted({str(row["reason"]) for row in failed})},
                "probe_ms": spread([row["probe_ms"] for row in rows if row["probe_ms"] is not None]),
                "probe_attempts": spread([row["probe_attempts"] for row in rows if row["probe_attempts"] is not None]),
                "travel_rad": spread([row["travel_rad"] for row in rows if row["ok"]]),
                "travel_beyond_sampled_posture": sum(row["ok"] and row["travel_rad"] > row.get("posture_travel_rad", math.inf)
                                                     + 1e-6 for row in rows)}
    return {"summary": {name: describe(rows[name]) for name in modes} | {
                "traces": {name: describe([row[name] for row in trace_rows]) for name in trace_modes}},
            "poses": rows, "traces": [{"id": row["id"], **{name: {key: row[name][key] for key in
                                       ("ok", "reason", "elapsed_ms", "probe_ms", "travel_rad")}
                                       for name in trace_modes}} for row in trace_rows]}


def benchmark():
    model = JointModel(json.loads((FIXTURES / "panda.json").read_text()), FIXTURES)
    corpus = json.loads((FIXTURES / "corpus.json").read_text())
    budgets = {"single_seed": {"budget": {"max_attempts": 1, "attempt_time_s": 1, "max_time_s": 1}},
               "bounded_restarts": {}}
    rng = random.Random(44)
    rows, chunks, negatives = ({name: [] for name in budgets} for _ in range(3))
    for options in budgets.values():
        for case in corpus["cases"][:3]:
            measure(model, options, case["goal"], case["seed"])
    for case in corpus["cases"]:
        order = list(budgets)
        rng.shuffle(order)
        for name in order:
            rows[name].append({"id": case["id"], "group": case["group"],
                               **measure(model, budgets[name], case["goal"], case["seed"])})
    for repeat in range(3):
        for index, sample in enumerate(corpus["chunks"]):
            order = list(budgets)
            rng.shuffle(order)
            for name in order:
                chunks[name].append({"id": index, "repeat": repeat, **chunk(model, budgets[name], sample)})
    for name, options in budgets.items():
        for case in corpus["cases"][:10]:
            row = measure(model, options, [10, *case["goal"][1:]], case["seed"])
            assert not row["ok"], "accepted an out-of-reach target"
            negatives[name].append(row)
    summary = {name: {
        "poses": summarize(rows[name]),
        "groups": {group: summarize([row for row in rows[name] if row["group"] == group])
                   for group in ("local", "medium", "global", "bounds")},
        "chunks": summarize(chunks[name]),
        "complete_chunks": summarize([row for row in chunks[name] if row["ok"]]),
        "max_chunk_joint_step_rad": max(row["max_joint_step_rad"] for row in chunks[name]),
        "negative_controls": summarize(negatives[name]),
    } for name in budgets}
    return {"metadata": {"python": platform.python_version(), "platform": platform.platform(),
                         "timing": "warm in-process URDF IK including FK verification and, on failure, the posture probe; randomized method order",
                         "baseline": "single seed, 200 Levenberg-Marquardt iterations, one-second guard",
                         "budget": budget_options(kinematics.DEFAULTS),
                         "tolerances": {key: kinematics.DEFAULTS[key]
                                        for key in ("position_tolerance_m", "rotation_tolerance_rad")}},
            "summary": summary, "poses": rows, "chunks": chunks, "negative_controls": negatives}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write detailed results as JSON")
    arguments = parser.parse_args()
    report = benchmark()
    x5_report = x5(global_search=hasattr(kinematics, "probe"))
    report["summary"]["x5"] = x5_report["summary"]
    report["x5"] = x5_report
    if arguments.output:
        arguments.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"metadata": report["metadata"], "summary": report["summary"]}, indent=2))
