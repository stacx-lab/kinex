"""Offline Panda IK comparison; run separately from CI's correctness tests.

PYTHONPATH=packages/core/assets/python python3 packages/core/test/benchmark_ik.py --output /tmp/kinex-ik.json
"""

import argparse
import json
import math
from pathlib import Path
import platform
import random
import statistics
from time import perf_counter
from unittest.mock import patch

from kinex.lib import kinematics
from kinex.lib.geometry import pose_error
from kinex.lib.joints import JointModel
from kinex.lib.kinematics import budget_options
from kinex.lib.urdf import joint_target


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


def measure(model, options, goal, seed):
    progress = []
    attempt = kinematics.Chain.attempt

    def recorded(*args):
        progress.append(args[-1])
        return attempt(*args)

    with patch.object(kinematics.Chain, "attempt", side_effect=recorded, autospec=True):
        start = perf_counter()
        try:
            q = model.ik(goal, seed, **options)
            error = None
        except ValueError as failure:
            if "IK search exhausted" not in str(failure):
                raise
            q, error = None, str(failure)
        elapsed = (perf_counter()-start) * 1000
    residual = None
    if q is not None:
        joint_target(q, model.joints)
        residual = pose_error(goal, model.fk(q))
        assert residual["position_m"] <= kinematics.DEFAULTS["position_tolerance_m"]
        assert residual["rotation_rad"] <= kinematics.DEFAULTS["rotation_tolerance_rad"]
    return {"ok": q is not None, "joints": q, "elapsed_ms": elapsed, "error": error,
            "residual": residual, "attempts": len(progress),
            "iterations": progress[-1].iterations if progress else 0}


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
                         "timing": "warm in-process URDF IK including FK verification; randomized method order",
                         "baseline": "single seed, original 200-iteration DLS step, one-second guard",
                         "budget": budget_options(kinematics.DEFAULTS),
                         "tolerances": {key: kinematics.DEFAULTS[key]
                                        for key in ("position_tolerance_m", "rotation_tolerance_rad")}},
            "summary": summary, "poses": rows, "chunks": chunks, "negative_controls": negatives}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Write detailed results as JSON")
    arguments = parser.parse_args()
    report = benchmark()
    if arguments.output:
        arguments.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"metadata": report["metadata"], "summary": report["summary"]}, indent=2))
