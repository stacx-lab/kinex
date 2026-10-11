"""Public bundle API and resumable provisioning orchestration (Python 3.10+).

Manifest/fact rules, host installation and generated files live in the sibling
bundle_manifest, bundle_install and bundle_render modules. Vendor provisioners
continue to import this module and supply their named steps to provision().
"""

import argparse
import ast
from contextlib import ExitStack
import secrets
import hashlib
import json
from importlib.util import resolve_name
import os
import shutil
import sys
import time
import subprocess
from pathlib import Path
from shlex import quote

from kinex_ros.bundle_manifest import (
    Bundle, BundleError, MissingFacts, MissingYaml, IDENTIFIER, NAME_PATTERN,
    atomic_write, coerce_fact, detect_ros_distro, device_name, evaluate_condition,
    fact_entry, load, questionnaire, read_yaml, redact, render, render_tree,
    ros_root, validate_facts, validate_manifest, write_json, write_yaml,
)
from kinex_ros.bundle_install import (
    apt_need, env_file_names, install, missing_apt, preflight, preflight_report, skip_install,
)
from kinex_ros.bundle_render import (
    render_check_sh, render_cyclonedds_xml, render_profile, render_recipe, render_robot,
    render_ros_python, render_stack_sh, write_profile, write_scripts,
)

SOURCE_FILES = ("bundle.yaml", "driver.py", "provision.py", "setup.sh", "check.py")
RUNTIME_FILES = ("bundle.yaml", "driver.py", "check.py")
RUNTIME_MODULES = ("__init__", "bundle_manifest", "ros2", "ros2_drivers", "ros2_check")
PROVISIONING_MODULES = ("provision", "kinex_ros.bundle", "kinex_ros.bundle_install", "kinex_ros.bundle_render")


class Needs(Exception):
    """A provisioning step stops with actionable needs instead of a result."""

    def __init__(self, needs):
        super().__init__("; ".join(need.get("text") or need.get("command") or need["id"] for need in needs))
        self.needs = needs


def inputs_hash(inputs):
    return hashlib.sha256(json.dumps(inputs, sort_keys=True, default=str).encode()).hexdigest()


class State:
    """Resumable provisioning record in ``<dir>/state.json`` (written atomically)."""

    def __init__(self, directory, bundle=None, bundle_version=None, source=None, parent=None):
        self.path = Path(directory) / "state.json"
        self.data = {"bundle": None, "bundle_version": None, "source": None, "steps": {}}
        if self.path.is_file():
            stored = json.loads(self.path.read_text())
            if isinstance(stored, dict):
                self.data.update(stored)
                self.data["steps"] = dict(stored.get("steps") or {})
        for key, value in (("bundle", bundle), ("bundle_version", bundle_version), ("source", source), ("parent", parent)):
            if value is not None:
                self.data[key] = value

    @property
    def source(self):
        return self.data["source"]

    @property
    def steps(self):
        return self.data["steps"]

    def save(self):
        atomic_write(self.path, json.dumps(self.data, indent=2) + "\n")

    def done(self, name):
        step = self.steps.get(name)
        return bool(step and step.get("done"))

    def run(self, name, inputs, fn, force=False):
        """Run ``fn()`` unless the step is done with the same inputs; return its note."""
        digest = inputs_hash(inputs)
        step = self.steps.get(name)
        if not force and step and step.get("done") and step.get("inputs_hash") == digest:
            return step.get("note")
        record = {"done": False, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "inputs_hash": digest, "note": None}
        try:
            note = fn()
        except Exception as error:
            record["note"] = str(error)
            self.steps[name] = record
            self.save()
            raise
        record.update(done=True, note=note)
        self.steps[name] = record
        self.save()
        return note

    def reset(self):
        self.data["steps"] = {}
        self.save()


def _library(value, package):
    directory = Path(value)
    if not directory.is_absolute() or not (directory / package / "__init__.py").is_file():
        raise BundleError(f"provide an absolute {'core' if package == 'kinex' else 'setup'} library containing {package}/__init__.py")
    return directory.resolve()


def _parser(bundle_dir):
    parser = argparse.ArgumentParser(prog="provision.py", description="Stage a complete device generation without changing its active profile.")
    parser.add_argument("--dir", default=str(bundle_dir))
    parser.add_argument("--core-library", required=True)
    parser.add_argument("--setup-library", required=True)
    parser.add_argument("--fact", action="append", default=[], metavar="KEY=VALUE")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--questionnaire", action="store_true")
    parser.add_argument("--step", help="force this step in a new candidate, then complete provisioning")
    parser.add_argument("--install", action="store_true", help="allow pip and Git dependency installation/builds; apt prerequisites must already be installed")
    return parser


def _fact_args(values):
    raw = {}
    for value in values:
        key, separator, text = value.partition("=")
        if not separator or not IDENTIFIER.match(key):
            raise BundleError(f"--fact expects key=value, got {value!r}")
        raw[key] = text
    return raw


def _check_owner(directory, bundle, parent=None):
    if directory.is_symlink():
        raise BundleError(f"bundle destination {directory} cannot be a symlink")
    if not directory.exists():
        return
    state = State(directory).data
    if state.get("bundle") == bundle.name and state.get("parent") == parent:
        return
    # Parent provisioning may extend a registered device or migrate an in-place
    # bundle. Satellites always require their own matching ownership receipt.
    manifest = directory / "bundle.yaml"
    if parent is None and state.get("bundle") is None and manifest.is_file() and load(directory).name == bundle.name:
        return
    profile = directory / "profile.yaml"
    if parent is None and state.get("bundle") is None and profile.is_file():
        registered = read_yaml(profile)
        if isinstance(registered, dict) and registered.get("name") == directory.name and registered.get("type") == bundle.type:
            return
    if any(file.name != ".provision.lock" for file in directory.iterdir()):
        raise BundleError(f"bundle destination {directory} is not owned by this parent and bundle")


def satellite_targets(bundle, facts, directory):
    targets, seen = [], {directory.resolve()}
    for item in bundle.manifest["satellites"]:
        name = render(item["name"], facts)
        if not NAME_PATTERN.fullmatch(name):
            raise BundleError(f"satellite name {name!r} is invalid")
        target = directory.parent / name
        if target.resolve() in seen:
            raise BundleError(f"duplicate or parent satellite destination {name!r}")
        seen.add(target.resolve())
        child = load(bundle.directory.parent / item["bundle"])
        if child.manifest["satellites"]:
            raise BundleError("nested satellite bundles are not supported")
        _check_owner(target, child, directory.name)
        declared = {fact["key"] for fact in child.manifest["facts"]}
        inherited = {**facts, "name": name}
        child_facts = {**inherited, **validate_facts(child, {k: v for k, v in inherited.items() if k in declared})}
        targets.append((child, child_facts, target))
    return targets


def _source_digest(source, setup_library, inputs=()):
    files = [(source / name, name) for name in SOURCE_FILES if (source / name).is_file()]
    files += [(source / name, "input/" + Path(name).as_posix()) for name in inputs]
    files += [(file, "python/" + str(file.relative_to(setup_library))) for file in sorted((setup_library / "kinex_ros").rglob("*.py"))]
    return {name: hashlib.sha256(file.read_bytes()).hexdigest() for file, name in files}


def _needs(needs):
    if needs:
        raise Needs(needs)


def _validate_runtime_imports(file, directory, tree):
    """Reject provisioning imports in deployed Python, including local helpers."""
    relative = file.relative_to(directory)
    parts = relative.parts[1:] if relative.parts[0] == "python" else relative.parts
    package = ".".join(parts[:-1])
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level and package:
                module = resolve_name("." * node.level + module, package)
            names = [module, *(f"{module}.{alias.name}".lstrip(".") for alias in node.names)]
        else:
            continue
        for name in names:
            if any(name == banned or name.startswith(banned + ".") for banned in PROVISIONING_MODULES):
                raise BundleError(f"{relative}:{node.lineno}: runtime must not import {name}; "
                                  "read configuration from kinex_ros.bundle_manifest and move provisioning to the source provisioner")


def _validate_generation(bundle):
    """Check staged syntax and required references without connecting to hardware."""
    for file in bundle.directory.rglob("*.py"):
        tree = ast.parse(file.read_text(), filename=str(file))
        _validate_runtime_imports(file, bundle.directory, tree)
    for name in ("ros-python", "stack.sh", "check.sh"):
        file = bundle.directory / name
        if file.is_file():
            result = subprocess.run(["bash", "-n", str(file)], capture_output=True, text=True)
            if result.returncode:
                raise BundleError(result.stderr.strip())
    profile = json.loads((bundle.directory / "profile.generated.json").read_text())
    entry = bundle.device_directory / profile["access"]["driver"]["entry"]
    staged = bundle.directory / entry.relative_to(bundle.target_directory)
    if not staged.is_file():
        raise BundleError(f"generated driver entry {entry} is missing")
    model = profile.get("intrinsics", {}).get("model", {})
    if model.get("format") == "urdf" and isinstance(model.get("path"), str) and model["path"] != "???":
        from xml.etree import ElementTree
        file = bundle.device_directory / model["path"]
        if file.is_relative_to(bundle.target_directory):
            file = bundle.directory / file.relative_to(bundle.target_directory)
        if ElementTree.parse(file).getroot().tag != "robot":
            raise BundleError("generated model is not a URDF robot")


def _stage(source, facts, directory, args, steps, parent=None, inputs=()):
    state = State(directory, bundle=source.name, bundle_version=source.manifest["version"], source=str(source.directory))
    digest = inputs_hash({"files": _source_digest(source.directory, args.setup_library, inputs), "facts": facts,
                         "core_library": str(args.core_library), "setup_library": str(args.setup_library),
                         "parent": str(parent) if parent else None, "ros_root": ros_root(), "install": args.install,
                         "skip": skip_install(), "runtime_files": RUNTIME_FILES, "runtime_modules": RUNTIME_MODULES})
    attempt = state.data.get("attempt", {})
    if attempt.get("digest") != digest or args.reset or args.step:
        attempt = {"id": secrets.token_hex(8), "digest": digest, "complete": False}
        state.data["steps"] = {}
    state.data.update(attempt=attempt, facts=facts, core_library=str(args.core_library), setup_library=str(args.setup_library))
    target = directory / "ros/generations" / attempt["id"]
    staging = directory / "ros/staging" / attempt["id"]
    # A crash between rename and the receipt update must not destroy the completed generation.
    if target.is_dir():
        bundle = load(target)
        _validate_generation(bundle)
        if not attempt.get("complete"):
            attempt["complete"] = True
            state.save()
        return bundle
    if attempt.get("complete"):
        raise BundleError(f"completed generation {target} is missing; rerun with --reset")
    staging.mkdir(parents=True, exist_ok=True)
    state.save()

    def stage_source():
        for name in RUNTIME_FILES:
            file = source.directory / name
            if file.is_file():
                shutil.copyfile(file, staging / name)
        helpers = staging / "python/kinex_ros"
        helpers.mkdir(parents=True, exist_ok=True)
        for name in RUNTIME_MODULES:
            shutil.copyfile(args.setup_library / "kinex_ros" / f"{name}.py", helpers / f"{name}.py")
        write_yaml(staging / "facts.yaml", facts)
        write_json(staging / "generation.json", {"device_directory": str(directory), "target_directory": str(target),
                   "parent_directory": str(parent) if parent else None, "digest": digest})

    state.run("stage", digest, stage_source)
    bundle = load(staging)
    state.run("facts", facts, lambda: "validated facts")
    state.run("preflight", {"facts": facts, "manifest": source.manifest, "install": args.install},
              lambda: _needs(preflight(bundle, facts)))
    state.run("install", {"facts": facts, "pins": source.manifest["pins"], "install": args.install},
              lambda: None if skip_install() or parent else _needs(install(bundle, facts, args.install)))
    for name, action in steps.items():
        state.run(name, {"facts": facts, "manifest": source.manifest}, lambda: action(bundle, facts, state))
    state.run("render", {"digest": digest, "target": str(target)},
              lambda: write_scripts(bundle, facts, str(args.core_library), parent))
    state.run("profile", {"digest": digest, "target": str(target)}, lambda: write_profile(bundle, facts))
    _validate_generation(bundle)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging.rename(target)
    bundle = load(target)
    _validate_generation(bundle)
    attempt["complete"] = True
    state.save()
    return bundle


def next_commands(bundle, facts):
    directory = bundle.target_directory
    name = device_name(bundle, facts)
    commands = []
    if bundle.manifest["robot"] is not None:
        commands.append(f"profile_write kind=robot with {directory / 'robot.generated.json'} when no robot is registered yet")
    commands.append(f"profile_write kind=device with {directory / 'profile.generated.json'} (new device); preserve existing facts when replacing access")
    if bundle.manifest["stack"] is not None or bundle.parent_directory:
        commands.append(f"bash {quote(str(directory / 'stack.sh'))} start")
    verification = "verify-base" if bundle.type == "velocity" else "verify-checks"
    commands += [f"/load {name}", f"bash {quote(str(directory / 'check.sh'))}",
                 f"calib_compute operation:{verification} measurements:{bundle.device_directory / 'verify/measurements.json'}"]
    return commands


def _provision(source, directory, args, steps, inputs):
    import fcntl
    if source.manifest["parent"]:
        raise BundleError("provision this satellite through its parent bundle to pin a complete parent generation")
    reserved = {"stage", "facts", "preflight", "install", "render", "profile"}
    if reserved.intersection(steps):
        raise BundleError("vendor steps must not replace built-in steps")
    if args.step and args.step not in reserved | steps.keys():
        raise BundleError(f"unknown step {args.step!r}; steps: {', '.join(sorted(reserved | steps.keys()))}")
    previous = State(directory).data.get("facts", {})
    facts = validate_facts(source, {**source.facts, **previous, **_fact_args(args.fact)})
    _check_owner(directory, source)
    children = satellite_targets(source, facts, directory)
    targets = [(source, facts, directory), *children]
    with ExitStack() as locks:
        for item, _, target in sorted(targets, key=lambda entry: str(entry[2])):
            target.mkdir(parents=True, exist_ok=True)
            lock = locks.enter_context((target / ".provision.lock").open("a"))
            fcntl.flock(lock, fcntl.LOCK_EX)
            # Lock files are not ownership receipts; only ignore our lock for an empty target.
            contents = [p for p in target.iterdir() if p.name != ".provision.lock"]
            if contents:
                _check_owner(target, item, None if target == directory else directory.name)
        for item, _, target in targets:
            state = State(target, bundle=item.name, bundle_version=item.manifest["version"], source=str(item.directory),
                          parent=None if target == directory else directory.name)
            state.save()
        parent = _stage(source, facts, directory, args, steps, inputs=inputs)
        bundles = [parent]
        for child, child_facts, target in children:
            bundles.append(_stage(child, child_facts, target, args, {}, parent.target_directory))
        return bundles


def provision(bundle_dir, argv, steps=None, *, inputs=()):
    """Stage a generation; inputs names extra files read by vendor steps. Core owns profile/lifecycle changes."""
    args = _parser(bundle_dir).parse_args(argv)
    directory = Path(args.dir).resolve()
    result = {"status": "ok", "dir": str(directory), "needs": [], "manual_steps": [], "next": []}
    code = 0
    try:
        if Path(args.dir).is_symlink():
            raise BundleError(f"bundle destination {args.dir} cannot be a symlink")
        args.core_library = _library(args.core_library, "kinex")
        args.setup_library = _library(args.setup_library, "kinex_ros")
        source = load(Path(bundle_dir).resolve())
        if args.questionnaire:
            print(json.dumps(questionnaire(source)))
            return 0
        result["manual_steps"] = source.manifest["manual_steps"]
        bundles = _provision(source, directory, args, steps or {}, inputs)
        result["generations"] = {device_name(bundle, bundle.facts): str(bundle.target_directory) for bundle in bundles}
        result["next"] = [command for bundle in bundles for command in next_commands(bundle, bundle.facts)]
    except MissingFacts as error:
        result.update(status="needs", needs=[{"kind": "fact", "id": entry["key"], **entry} for entry in error.missing])
        code = 2
    except Needs as error:
        result.update(status="needs", needs=error.needs)
        code = 2
    except MissingYaml as error:
        result.update(status="needs", needs=[{**apt_need("python3-yaml", ["python3-yaml"]), "text": str(error)}])
        code = 2
    except (BundleError, OSError, ValueError) as error:
        result.update(status="error", error=str(error))
        code = 1
    except Exception as error:
        result.update(status="error", error=f"{type(error).__name__}: {error}")
        code = 1
    print(json.dumps(result), flush=True)
    return code


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m kinex_ros.bundle")
    parser.add_argument("--dir", required=True)
    parser.add_argument("command", choices=("questionnaire", "state"))
    args = parser.parse_args(argv)
    print(json.dumps(questionnaire(load(args.dir)) if args.command == "questionnaire" else State(args.dir).data, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
