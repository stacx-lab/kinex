"""Read-only ROS interface checks and explicitly requested model capture.

The measurement document is consumed by setup's verify-base or verify-checks operation. This
module runs from a provisioned generation and never commands a robot or manages its stack.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path
from xml.etree import ElementTree

from kinex_ros.bundle_manifest import atomic_write, generation_metadata, render_tree, write_json
from kinex_ros.ros2 import BundleError, Session
from kinex_ros.ros2_drivers import CameraSource, configuration, positive


def validate_checks(checks):
    """Validate measured evidence without invoking a setup computation."""
    if not checks:
        raise BundleError("bundle declares no interface checks", "invalid_checks")
    seen, normalized = set(), []
    for original in checks:
        check = {key: value for key, value in original.items() if key != "passed"}
        name = check.get("name")
        if not isinstance(name, str) or not name or name in seen:
            raise BundleError("check names must be nonempty and unique", "invalid_checks")
        seen.add(name)
        if not isinstance(check.get("reference"), str) or not check["reference"].strip():
            raise BundleError(f"{name}: reference evidence is required", "invalid_checks")
        if not {"expected", "measured"} <= set(check):
            raise BundleError(f"{name}: expected and measured values are required", "invalid_checks")
        expected, measured = check["expected"], check["measured"]
        if "tolerance" in check or type(expected) in (int, float) or type(measured) in (int, float):
            numbers = (expected, measured, check.get("tolerance"))
            if any(type(value) not in (int, float) or not math.isfinite(value) for value in numbers) or numbers[2] < 0:
                raise BundleError(f"{name}: finite measurements and a nonnegative tolerance are required", "invalid_checks")
            if not isinstance(check.get("units"), str) or not check["units"]:
                raise BundleError(f"{name}: units are required", "invalid_checks")
            passed = abs(expected - measured) <= numbers[2]
        else:
            passed = expected == measured
        stamps = check.get("timestamps", [])
        if stamps and (len(stamps) < 2 or any(type(stamp) not in (int, float) or not math.isfinite(stamp) for stamp in stamps)
                       or any(left >= right for left, right in zip(stamps, stamps[1:]))):
            raise BundleError(f"{name}: timestamps must increase", "invalid_checks")
        # Validate nested values too: NaN cannot become successful equality evidence.
        json.dumps(check, allow_nan=False)
        normalized.append((check, passed))
    return normalized


def extra_checks(directory, session, bundle):
    file = Path(directory) / "check.py"
    if not file.is_file():
        return []
    spec = importlib.util.spec_from_file_location("kinex_bundle_checks", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    values = module.checks(session, bundle, bundle.facts)
    if not isinstance(values, list):
        raise BundleError("bundle check.py must return a list of checks", "invalid_checks")
    return values


def parameters(session, expected):
    checks = []
    for parameter in expected.get("parameters", []):
        value = session.param(parameter["node"], parameter["name"], parameter.get("timeout_s", 1))
        check = {"name": f"param:{parameter['node'].rstrip('/')}/{parameter['name']}",
                 "expected": parameter["expected"], "measured": value, "reference": "ROS get_parameters service"}
        if type(value) in (int, float) or type(parameter["expected"]) in (int, float):
            check.update(tolerance=parameter.get("tolerance", 0), units=parameter.get("units", "1"))
        checks.append(check)
    return checks


def camera_checks(directory):
    """Save observed intrinsics for repair and compare them with the active profile."""
    camera = CameraSource(directory)
    try:
        observed = camera.introspect()
        write_json(camera.directory / "profile.patch.json", observed)
        checks = []
        for channel in ("color", "depth"):
            for field, measured in observed["intrinsics"].get(channel, {}).items():
                # Introspection does not measure FPS or establish vendor depth
                # scale/registration facts; only compare fields it observes.
                if field == "fps":
                    continue
                entry = {"name": f"camera:{channel}:{field}",
                         "expected": camera.profile["intrinsics"][channel].get(field), "measured": measured,
                         "reference": f"ROS Image/CameraInfo vs profile.intrinsics.{channel}.{field}"}
                if field in ("width", "height") and type(entry["expected"]) in (int, float):
                    entry.update(tolerance=0, units="px")
                elif field in ("width", "height"):
                    # Unknown profile geometry is a failed check, not malformed
                    # numeric evidence; the patch supplies its missing value.
                    entry["expected"], entry["measured"] = str(entry["expected"]), str(measured)
                checks.append(entry)
        return checks
    finally:
        camera.close()


def capture_identity(session, expected, driver, description):
    record = {"recorded_at": datetime.now(timezone.utc).isoformat(), "domain_id": session.domain_id,
              "namespace": session.node.get_namespace(), "robot_description_sha256": hashlib.sha256(description.encode()).hexdigest()}
    topic = expected.get("identity", {}).get("single_publisher", driver.get("state_topic"))
    if topic:
        publishers = session.publishers(topic)
        if len(publishers) != 1:
            raise BundleError("model capture requires one state publisher", "identity_mismatch")
        publisher = publishers[0]
        record["publisher_node"] = publisher.node_namespace.rstrip("/") + "/" + publisher.node_name
    if expected.get("joints"):
        topic = expected.get("state_topic", driver.get("state_topic", "/joint_states"))
        record["joint_names"] = list(session.latest(topic, "sensor_msgs/msg/JointState").wait(1).name)
    return record


def _check(directory, out, duration_s, ready, save_urdf, introspect, timeout_s):
    directory = Path(directory).resolve()
    bundle, driver, expected, identity = configuration(directory, allow_missing_model=save_urdf or ready)
    duration_s = positive(duration_s, "duration_s")
    stack = render_tree(bundle.manifest["stack"] or {}, bundle.facts)
    deadline_s = positive(timeout_s if timeout_s is not None else stack.get("ready_timeout_s", 60), "timeout_s")
    session = Session("kinex_check", bundle.facts.get("domain_id", 0), bundle.facts.get("namespace", ""), driver.get("clock", {}).get("max_skew_s", .5))
    output = Path(out) if out else bundle.device_directory / "verify/measurements.json"
    try:
        session.open()
        if ready:
            topics = stack.get("ready_topics", [])
            if not topics:
                raise BundleError("stack.ready_topics is empty", "invalid_bundle")
            session.wait_topics(topics, deadline_s)
            return {"ok": True, "checks": [], "required_checks": []}, []
        topics = [topic["name"] for topic in expected.get("topics", []) if topic.get("required", True)
                  and not (topic.get("skip_when") and bundle.facts.get(topic["skip_when"]))]
        if topics:
            session.wait_topics(topics, deadline_s)
        if not any(expected.get(key) for key in ("topics", "controllers", "joints", "frames", "robot_description", "parameters")) and not (directory / "check.py").is_file():
            raise BundleError("bundle declares no interface checks", "invalid_checks")
        expected["domain"] = True
        if driver.get("state_topic"):
            expected.setdefault("state_topic", driver["state_topic"])
            expected.setdefault("identity", {}).setdefault("single_publisher", driver["state_topic"])
        description_spec = expected.get("robot_description", {})
        compare = description_spec.get("compare_to")
        if compare and not (directory / compare).is_file() and not (bundle.device_directory / compare).is_file() and not save_urdf:
            raise BundleError(f"reference URDF {compare} is missing; capture it explicitly with --save-urdf", "missing_model")
        result = session.expect(expected, bundle.facts, duration_s, identity)
        values = result.checks + parameters(session, expected) + extra_checks(directory, session, bundle)
        if introspect:
            values += camera_checks(directory)
        assessed = validate_checks(values)
        checks = [entry for entry, _ in assessed]
        document = {"required_checks": [entry["name"] for entry in checks], "checks": checks,
                    "recorded_at": datetime.now(timezone.utc).isoformat(),
                    "information": {"driver_loss": driver.get("stop", {}).get("driver_loss"),
                                    "driver_loss_note": "Declared behavior only; this check does not kill a driver or measure its loss response."}}
        failures = [f"FAIL {entry['name']}: expected {entry['expected']!r} measured {entry['measured']!r}" for entry, passed in assessed if not passed]
        if not failures and save_urdf:
            description = session.robot_description(topic=description_spec.get("topic", "/robot_description"),
                                                    parameter_node=description_spec.get("parameter_node", "/robot_state_publisher"), timeout_s=min(deadline_s, 2))
            if ElementTree.fromstring(description).tag != "robot":
                raise BundleError("robot_description is not a URDF robot", "invalid_model")
            captured = capture_identity(session, expected, driver, description)
            atomic_write(bundle.device_directory / "model.urdf", description)
            write_json(bundle.device_directory / "identity.json", captured)
        write_json(output, document)
        return document, failures[:20]
    finally:
        session.close()


def check(directory, out=None, duration_s=3, ready=False, save_urdf=False, introspect=False, timeout_s=None):
    output = Path(out) if out else Path(directory) / "verify/measurements.json"
    try:
        if out is None:
            generation = generation_metadata(directory)
            device = Path(generation["device_directory"]) if generation is not None else Path(directory)
            output = device / "verify/measurements.json"
        return _check(directory, output, duration_s, ready, save_urdf, introspect, timeout_s)
    except Exception as error:
        if not ready:
            # Include configuration and cleanup failures: never leave stale
            # passing evidence after an unsuccessful checker invocation.
            write_json(output, {"required_checks": ["checker_completed"], "checks": [{"name": "checker_completed", "expected": True,
                       "measured": False, "reference": f"{type(error).__name__}: {error}"}]})
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True)
    parser.add_argument("--out")
    parser.add_argument("--duration-s", type=float, default=3)
    parser.add_argument("--timeout-s", type=float)
    parser.add_argument("--ready", action="store_true")
    parser.add_argument("--save-urdf", action="store_true")
    parser.add_argument("--introspect", action="store_true")
    args = parser.parse_args(argv)
    if args.ready and (args.save_urdf or args.introspect):
        parser.error("--ready cannot capture a model or introspection")
    try:
        _, failures = check(args.dir, args.out, args.duration_s, args.ready, args.save_urdf, args.introspect, args.timeout_s)
        print("\n".join(failures) if failures else "ok")
        return 1 if failures else 0
    except Exception as error:
        print(f"FAIL {getattr(error, 'code', 'checker')}: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
