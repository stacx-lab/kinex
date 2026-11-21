"""Assertions about a locomotion base, checked against explicit references and tolerances."""
import math

from kinex.lib.calibration import CalibrationError


def verify(run, required_checks, checks):
    """Evaluate selected base checks; passes when every required check is present and holds.

    required_checks names the task's checks; only they decide coverage and quality. Each
    check is {name, expected, measured, reference, tolerance?, units?, timestamps?}:
    reference names the archived source or independent measurement; numbers need tolerance
    and units, other values compare exactly; timestamps, when given, are at least two
    distinct increasing sample times. Covers only the recorded trial conditions: do not
    claim untested axes or conditions. Nothing is proposed for the profile.

    Example: result = lib.calibration.base.verify(run, ["vx"], [{"name": "vx", "expected": 0.1,
        "measured": 0.104, "tolerance": 0.01, "units": "m/s", "reference": "tracked displacement"}])
    """
    run.save("measurements", {"required_checks": required_checks, "checks": checks})
    return run._solve("verify-base", lambda: _evaluate(required_checks, checks), lambda data: "passed" if data["quality_pass"] else "failed")


def _evaluate(required, checks):
    if not isinstance(required, list) or not required or not all(isinstance(name, str) and name for name in required):
        raise CalibrationError("required_checks must name the task-selected checks")
    if len(set(required)) != len(required) or not isinstance(checks, list):
        raise CalibrationError("duplicate required checks or missing checks")
    results, seen = [], set()
    for check in checks:
        name = check.get("name")
        if name in seen:
            raise CalibrationError(f"duplicate check: {name}")
        seen.add(name)
        if not isinstance(check.get("reference"), str) or not check["reference"].strip():
            raise CalibrationError(f"{name}: supply the measurement/reference source")
        stamps = check.get("timestamps", [])
        if stamps and (len(stamps) < 2 or not all(_finite(value) for value in stamps) or any(a >= b for a, b in zip(stamps, stamps[1:]))):
            raise CalibrationError(f"{name}: timestamps must be distinct and increasing")
        expected, measured = check.get("expected"), check.get("measured")
        if "tolerance" in check:
            tolerance = check["tolerance"]
            if not all(_finite(value) for value in (expected, measured, tolerance)) or tolerance < 0:
                raise CalibrationError(f"{name}: finite numeric values and nonnegative tolerance required")
            if not isinstance(check.get("units"), str) or not check["units"]:
                raise CalibrationError(f"{name}: declare measurement units")
            error = abs(measured - expected)
            results.append({"name": name, "passed": error <= tolerance, "error": error, "units": check["units"]})
        elif _finite(expected) or _finite(measured):
            raise CalibrationError(f"{name}: numeric measurements require an explicit tolerance")
        else:
            results.append({"name": name, "passed": expected == measured})
    missing = [name for name in required if name not in seen]
    return {"quality_pass": not missing and all(result["passed"] for result in results if result["name"] in required),
            "checks": results, "missing": missing, "coverage": required}


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)
