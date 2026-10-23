#!/usr/bin/env python3
"""Offline tip_link reach estimate in the joint device base frame from its URDF."""

import argparse
import json
import math
from pathlib import Path

import numpy as np
import yaml

from kinex.lib.joints import JointModel


def estimate(file, count, percentile):
    if count < 1 or not 0 < percentile <= 100:
        raise ValueError("samples must be positive and percentile in (0,100]")
    profile = yaml.safe_load(file.read_text())
    model = JointModel(profile, file.parent)
    if not model.tip:
        raise ValueError("offline reach requires a model tip_link")
    # Only continuous joints lack URDF limits.
    bounds = [[j["limits"]["min"], j["limits"]["max"]] if j["limits"] else [-math.pi, math.pi] for j in model.joints]
    rng = np.random.default_rng(0)
    configurations = rng.uniform(np.array(bounds)[:, 0], np.array(bounds)[:, 1], (count, len(bounds)))
    positions = np.array([model.fk(q.tolist())[:3] for q in configurations])
    trim = (100 - percentile) / 2
    return {"ok": True, "frame": profile["name"], "samples": count,
            "percentile": percentile, "aabb_min": np.percentile(positions, trim, axis=0).tolist(),
            "aabb_max": np.percentile(positions, 100 - trim, axis=0).tolist(),
            "max_reach_m": float(np.percentile(np.linalg.norm(positions, axis=1), percentile))}


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
