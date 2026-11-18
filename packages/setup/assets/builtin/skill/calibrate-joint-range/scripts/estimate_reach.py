#!/usr/bin/env python3
"""Offline reach estimate of each tip link in the joint device base frame from its URDF."""

import argparse
import json
import math
from pathlib import Path

import numpy as np
import yaml

from kinex.common.joints import JointModel


def estimate(file, count, percentile):
    if count < 1 or not 0 < percentile <= 100:
        raise ValueError("samples must be positive and percentile in (0,100]")
    profile = yaml.safe_load(file.read_text())
    model = JointModel(profile, file.parent)
    if not model.tips:
        raise ValueError("offline reach requires model tip_links")
    # Only continuous joints lack URDF limits.
    bounds = [[j["limits"]["min"], j["limits"]["max"]] if j["limits"] else [-math.pi, math.pi] for j in model.joints]
    rng = np.random.default_rng(0)
    configurations = rng.uniform(np.array(bounds)[:, 0], np.array(bounds)[:, 1], (count, len(bounds)))
    trim = (100 - percentile) / 2

    def reach(tip):
        positions = np.array([model.fk(q.tolist(), tip)[:3] for q in configurations])
        return {"aabb_min": np.percentile(positions, trim, axis=0).tolist(),
                "aabb_max": np.percentile(positions, 100 - trim, axis=0).tolist(),
                "max_reach_m": float(np.percentile(np.linalg.norm(positions, axis=1), percentile))}

    return {"ok": True, "frame": profile["name"], "samples": count, "percentile": percentile,
            "tips": {tip: reach(tip) for tip in model.tips}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--samples", type=int, default=20000)
    parser.add_argument("--percentile", type=float, default=99)
    options = parser.parse_args()
    try:
        result = estimate(options.profile, options.samples, options.percentile)
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        raise SystemExit(1)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
