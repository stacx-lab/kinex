#!/usr/bin/env python3
"""Evaluate selected base measurements without commanding hardware or tuning it."""
import argparse
import json
import math


def evaluate(document):
    required = document.get("required_checks")
    checks = document.get("checks")
    if not isinstance(required, list) or not required or not all(isinstance(v, str) and v for v in required):
        raise ValueError("required_checks must name the task-selected checks")
    if len(set(required)) != len(required) or not isinstance(checks, list):
        raise ValueError("duplicate required checks or missing checks")
    results, seen = [], set()
    for check in checks:
        name = check["name"]
        if name in seen:
            raise ValueError("duplicate check: " + name)
        seen.add(name)
        if not isinstance(check.get("reference"), str) or not check["reference"].strip():
            raise ValueError(name + ": supply the measurement/reference source")
        stamps = check.get("timestamps", [])
        if stamps and (len(stamps) < 2 or any(not isinstance(v, (float, int)) or not math.isfinite(v) for v in stamps)
                       or any(a >= b for a, b in zip(stamps, stamps[1:]))):
            raise ValueError(name + ": timestamps must be distinct and increasing")
        expected, measured = check["expected"], check["measured"]
        if "tolerance" in check:
            tolerance = check["tolerance"]
            if not all(type(v) in (int, float) and math.isfinite(v) for v in (expected, measured, tolerance)) or tolerance < 0:
                raise ValueError(name + ": finite numeric values and nonnegative tolerance required")
            if not isinstance(check.get("units"), str) or not check["units"]:
                raise ValueError(name + ": declare measurement units")
            error = abs(measured - expected)
            results.append({"name": name, "passed": error <= tolerance, "error": error, "units": check["units"]})
        else:
            if type(expected) in (int, float) or type(measured) in (int, float):
                raise ValueError(name + ": numeric measurements require an explicit tolerance")
            results.append({"name": name, "passed": expected == measured})
    missing = [name for name in required if name not in seen]
    return {"ok": True, "quality_pass": not missing and all(r["passed"] for r in results if r["name"] in required),
            "checks": results, "missing": missing,
            "coverage": required, "note": "Assessment applies only to the selected checks and recorded trial conditions."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--measurements", required=True)
    args = parser.parse_args()
    try:
        with open(args.measurements, encoding="utf8") as source:
            result = evaluate(json.load(source))
    except (OSError, ValueError, KeyError, TypeError) as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
