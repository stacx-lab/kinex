"""Bundle manifests, typed facts and fact-based templates; no installation or ROS imports."""

import copy
import ipaddress
import json
import os
import re
import string
import tempfile
from functools import total_ordering
from pathlib import Path

DEVICE_TYPES = ("velocity", "dexterous_hand", "suction", "joint", "gripper", "rgb", "rgbd", "imu",
                "force_torque", "model", "detection", "segmentation", "world", "other")
FACT_TYPES = ("string", "int", "bool", "ip", "enum", "path")
PREFLIGHT_KINDS = ("platform", "file", "python", "command", "apt", "env_file", "can")
MANUAL_WHEN = ("before_install", "before_stack", "before_load")
NODE_KINDS = ("prepare", "calibrate", "verify")
NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SECRET_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
REDACTED = re.compile(r"key|token|password|secret", re.IGNORECASE)


class BundleError(ValueError):
    """Invalid manifest, facts or template; the message names the field path."""


class MissingYaml(BundleError):
    """PyYAML is not importable by the provisioning interpreter."""


class MissingFacts(BundleError):
    """Required facts are absent; ``missing`` lists questionnaire entries for them."""

    def __init__(self, missing):
        super().__init__("missing facts: " + ", ".join(entry["key"] for entry in missing))
        self.missing = missing


def _yaml():
    try:
        import yaml
    except ImportError:
        raise MissingYaml("PyYAML is required: sudo apt-get install -y python3-yaml") from None
    return yaml


def read_yaml(path):
    data = _yaml().safe_load(Path(path).read_text())
    return {} if data is None else data


def write_yaml(path, data):
    text = _yaml().safe_dump(data, sort_keys=False, default_flow_style=False)
    atomic_write(Path(path), text)


def atomic_write(path, text, executable=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", newline="\n", dir=path.parent,
                                     prefix=".kinex-", delete=False) as output:
        temporary = Path(output.name)
        output.write(text)
    try:
        if executable:
            temporary.chmod(0o755)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path, value):
    atomic_write(path, json.dumps(value, indent=2, allow_nan=False) + "\n")


def ros_root():
    return os.environ.get("KINEX_BUNDLE_ROS_ROOT") or "/opt/ros"


# Manifest ------------------------------------------------------------------


def _label(path):
    return path or "manifest"


def _mapping(value, path, required=(), optional=()):
    if not isinstance(value, dict):
        raise BundleError(f"{_label(path)} must be a mapping")
    unknown = sorted(key for key in value if key not in required and key not in optional)
    if unknown:
        raise BundleError(f"{_label(path)}: unknown keys {', '.join(map(str, unknown))}")
    for key in required:
        if key not in value:
            raise BundleError(f"{_join(path, key)} is required")
    return value


def _join(path, key):
    return f"{path}.{key}" if path else str(key)


def _list(value, path, check=None):
    if not isinstance(value, list):
        raise BundleError(f"{_label(path)} must be a list")
    if check is None:
        return list(value)
    return [check(item, f"{path}[{index}]") for index, item in enumerate(value)]


def _string(value, path, pattern=None):
    if not isinstance(value, str) or not value:
        raise BundleError(f"{_label(path)} must be a non-empty string")
    if pattern is not None and not pattern.match(value):
        raise BundleError(f"{_label(path)} must match {pattern.pattern}")
    return value


def _text(value, path):
    if not isinstance(value, str):
        raise BundleError(f"{_label(path)} must be a string")
    return value


def _bool(value, path):
    if not isinstance(value, bool):
        raise BundleError(f"{_label(path)} must be true or false")
    return value


def _number(value, path, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BundleError(f"{_label(path)} must be a number")
    if positive and value <= 0:
        raise BundleError(f"{_label(path)} must be positive")
    return value


def _choice(value, path, options):
    if value not in options:
        raise BundleError(f"{_label(path)} must be one of {', '.join(options)}")
    return value


def _strings(value, path):
    return _list(value, path, _string)


def _fact(fact, path):
    _mapping(fact, path, ("key", "type"), ("required", "enum", "pattern", "min", "max", "default", "ask", "description"))
    key = _string(fact["key"], _join(path, "key"), IDENTIFIER)
    kind = _choice(fact["type"], _join(path, "type"), FACT_TYPES)
    required = fact.get("required", False)
    if isinstance(required, dict):
        _mapping(required, _join(path, "required"), ("when",))
        _string(required["when"], _join(path, "required.when"))
        _compile(required["when"], _join(path, "required.when"))
    else:
        _bool(required, _join(path, "required"))
    enum = fact.get("enum")
    if kind == "enum" and enum is None:
        raise BundleError(f"{_join(path, 'enum')} is required for type enum")
    if enum is not None:
        enum = _strings(enum, _join(path, "enum"))
        if not enum:
            raise BundleError(f"{_join(path, 'enum')} must not be empty")
    pattern = fact.get("pattern")
    if pattern is not None:
        try:
            re.compile(_string(pattern, _join(path, "pattern")))
        except re.error as error:
            raise BundleError(f"{_join(path, 'pattern')} is not a valid regex: {error}") from None
    for bound in ("min", "max"):
        if bound in fact:
            if kind != "int":
                raise BundleError(f"{_join(path, bound)} applies to type int only")
            _number(fact[bound], _join(path, bound))
    default = fact.get("default")
    if isinstance(default, dict):
        _mapping(default, _join(path, "default"), ("detect",))
        _choice(default["detect"], _join(path, "default.detect"), ("ros_distro",))
    return {"key": key, "type": kind, "required": required, "enum": enum, "pattern": pattern,
            "min": fact.get("min"), "max": fact.get("max"), "default": default,
            "ask": _bool(fact.get("ask", True), _join(path, "ask")),
            "description": _text(fact.get("description", ""), _join(path, "description"))}


def _facts(value, path):
    facts = _list(value, path, _fact)
    seen = set()
    for index, fact in enumerate(facts):
        if fact["key"] in seen:
            raise BundleError(f"{path}[{index}].key duplicates {fact['key']}")
        seen.add(fact["key"])
    return facts


def _ros(value, path):
    _mapping(value, path, (), ("distros", "rmw", "python"))
    rmw = value.get("rmw")
    if rmw is not None:
        _string(rmw, _join(path, "rmw"))
    return {"distros": _strings(value.get("distros", []), _join(path, "distros")), "rmw": rmw,
            "python": _string(value.get("python", "/usr/bin/python3"), _join(path, "python"))}


def _git_pin(value, path):
    _mapping(value, path, ("url", "rev"), ("build",))
    build = value.get("build")
    if build is not None:
        _choice(build, _join(path, "build"), ("colcon",))
    return {"url": _string(value["url"], _join(path, "url")), "rev": _string(value["rev"], _join(path, "rev")), "build": build}


def _pins(value, path):
    _mapping(value, path, (), ("apt", "pip", "git"))
    return {"apt": _strings(value.get("apt", []), _join(path, "apt")),
            "pip": _strings(value.get("pip", []), _join(path, "pip")),
            "git": _list(value.get("git", []), _join(path, "git"), _git_pin)}


PREFLIGHT_FIELDS = {"platform": (("value",), ()), "file": (("path",), ()), "python": (("min",), ()),
                    "command": (("argv",), ()), "apt": (("packages",), ()), "env_file": (("names",), ()),
                    "can": (("interface",), ("bitrate",))}


def _preflight_item(value, path):
    if not isinstance(value, dict) or "kind" not in value:
        raise BundleError(f"{_join(path, 'kind')} is required")
    kind = _choice(value["kind"], _join(path, "kind"), PREFLIGHT_KINDS)
    required, optional = PREFLIGHT_FIELDS[kind]
    _mapping(value, path, ("id", "kind") + required, ("skip_when",) + optional)
    item = {"id": _string(value["id"], _join(path, "id")), "kind": kind, "skip_when": value.get("skip_when")}
    if item["skip_when"] is not None:
        _string(item["skip_when"], _join(path, "skip_when"), IDENTIFIER)
    if kind == "command":
        item["argv"] = _strings(value["argv"], _join(path, "argv"))
    elif kind == "apt":
        item["packages"] = _reference(value["packages"], _join(path, "packages"), "pins.apt")
    elif kind == "env_file":
        item["names"] = _reference(value["names"], _join(path, "names"), "secrets")
    elif kind == "can":
        item["interface"] = _string(value["interface"], _join(path, "interface"))
        item["bitrate"] = value.get("bitrate")
    else:
        field = required[0]
        item[field] = _string(value[field], _join(path, field))
    return item


def _reference(value, path, name):
    if value == name:
        return name
    return _strings(value, path)


def _manual_step(value, path):
    _mapping(value, path, ("id", "when", "text"))
    return {"id": _string(value["id"], _join(path, "id")), "when": _choice(value["when"], _join(path, "when"), MANUAL_WHEN),
            "text": _string(value["text"], _join(path, "text"))}


def _stack(value, path):
    if value is None:
        return None
    _mapping(value, path, (), ("launch", "env", "ready_topics", "ready_timeout_s", "stop", "borrowed_from"))
    launch = value.get("launch")
    if launch is not None:
        _mapping(launch, _join(path, "launch"), ("package", "file"), ("args",))
        launch = {"package": _string(launch["package"], _join(path, "launch.package")),
                  "file": _string(launch["file"], _join(path, "launch.file")),
                  "args": _text(launch.get("args", ""), _join(path, "launch.args"))}
    env = value.get("env", {})
    if not isinstance(env, dict):
        raise BundleError(f"{_join(path, 'env')} must be a mapping")
    for key, entry in env.items():
        _string(key, _join(path, "env"), SECRET_NAME)
        _text(entry, _join(path, f"env.{key}"))
    stop = value.get("stop", {})
    _mapping(stop, _join(path, "stop"), (), ("signal", "timeout_s"))
    return {"launch": launch, "env": dict(env), "ready_topics": _strings(value.get("ready_topics", []), _join(path, "ready_topics")),
            "ready_timeout_s": _number(value.get("ready_timeout_s", 60), _join(path, "ready_timeout_s"), positive=True),
            "stop": {"signal": _choice(stop.get("signal", "INT"), _join(path, "stop.signal"), ("INT", "TERM")),
                     "timeout_s": _number(stop.get("timeout_s", 10), _join(path, "stop.timeout_s"), positive=True)},
            "borrowed_from": value.get("borrowed_from")}


def _driver(value, path):
    if not isinstance(value, dict):
        raise BundleError(f"{_label(path)} must be a mapping")
    if "actions" in value:
        _list(value["actions"], _join(path, "actions"), lambda item, where: _string(item, where, NAME_PATTERN))
    if "timeout_s" in value:
        _number(value["timeout_s"], _join(path, "timeout_s"), positive=True)
    for key in ("state_topic", "command_topic", "color_topic", "depth_topic", "camera_info_topic"):
        if key in value:
            _string(value[key], _join(path, key))
    for key in ("color_image_space", "depth_image_space"):
        if key in value:
            image_space = _string(value[key], _join(path, key))
            # Fact substitutions are checked after rendering by the adapter.
            if "$" not in image_space:
                _choice(image_space, _join(path, key), ("raw", "rectified"))
    return dict(value)


def _profile(value, path):
    _mapping(value, path, (), ("access", "intrinsics", "extrinsics"))
    access = value.get("access", {})
    _mapping(access, _join(path, "access"), (), ("connection", "driver"))
    if "connection" in access and not isinstance(access["connection"], dict):
        raise BundleError(f"{_join(path, 'access.connection')} must be a mapping")
    if "driver" in access:
        _mapping(access["driver"], _join(path, "access.driver"), (), ("interpreter",))
    for key in ("intrinsics", "extrinsics"):
        if key in value and not isinstance(value[key], dict):
            raise BundleError(f"{_join(path, key)} must be a mapping")
    return {"access": access, "intrinsics": value.get("intrinsics", {}), "extrinsics": value.get("extrinsics", {})}


def _node(value, path):
    _mapping(value, path, ("id", "title", "kind", "skill"), ("bindings", "dependsOn", "inputs", "outputs", "optional"))
    _string(value["id"], _join(path, "id"))
    _string(value["title"], _join(path, "title"))
    _choice(value["kind"], _join(path, "kind"), NODE_KINDS)
    _string(value["skill"], _join(path, "skill"))
    return dict(value)


def _recipe(value, path):
    if value is None:
        return None
    _mapping(value, path, ("nodes",), ("task",))
    nodes = _list(value["nodes"], _join(path, "nodes"), _node)
    task = value.get("task")
    if task is not None:
        _mapping(task, _join(path, "task"), ("objective",), ("targets",))
        _string(task["objective"], _join(path, "task.objective"))
    return {"nodes": nodes, "task": task}


def _satellite(value, path):
    _mapping(value, path, ("bundle", "name"))
    return {"bundle": _string(value["bundle"], _join(path, "bundle"), NAME_PATTERN), "name": _string(value["name"], _join(path, "name"))}


def _robot(value, path):
    if value is None:
        return None
    _mapping(value, path, ("kind",), ("model_fact", "model"))
    robot = {"kind": _string(value["kind"], _join(path, "kind")), "model_fact": value.get("model_fact"), "model": value.get("model")}
    for key in ("model_fact", "model"):
        if robot[key] is not None:
            _string(robot[key], _join(path, key))
    return robot


def validate_manifest(data):
    """Return the normalized manifest or raise BundleError naming the offending field."""
    _mapping(data, "", ("version", "name", "device", "facts"),
             ("robot", "parent", "ros", "secrets", "pins", "preflight", "manual_steps", "stack", "expected",
              "driver", "profile", "recipe", "satellites"))
    if data["version"] != 1:
        raise BundleError("version must be 1")
    _mapping(data["device"], "device", ("type",))
    parent = data.get("parent")
    if parent is not None:
        _string(parent, "parent", NAME_PATTERN)
    expected = data.get("expected", {})
    if not isinstance(expected, dict):
        raise BundleError("expected must be a mapping")
    return {
        "version": 1,
        "name": _string(data["name"], "name", NAME_PATTERN),
        "device": {"type": _choice(data["device"]["type"], "device.type", DEVICE_TYPES)},
        "robot": _robot(data.get("robot"), "robot"),
        "parent": parent,
        "ros": _ros(data.get("ros", {}), "ros"),
        "facts": _facts(data["facts"], "facts"),
        "secrets": _list(data.get("secrets", []), "secrets", lambda item, path: _string(item, path, SECRET_NAME)),
        "pins": _pins(data.get("pins", {}), "pins"),
        "preflight": _list(data.get("preflight", []), "preflight", _preflight_item),
        "manual_steps": _list(data.get("manual_steps", []), "manual_steps", _manual_step),
        "stack": _stack(data.get("stack"), "stack"),
        "expected": expected,
        "driver": _driver(data.get("driver", {}), "driver"),
        "profile": _profile(data.get("profile", {}), "profile"),
        "recipe": _recipe(data.get("recipe"), "recipe"),
        "satellites": _list(data.get("satellites", []), "satellites", _satellite),
    }


class Bundle:
    def __init__(self, directory, manifest, facts):
        self.directory = Path(directory)
        self.manifest = manifest
        self.facts = facts
        self.device_directory = self.directory
        self.target_directory = self.directory
        self.parent_directory = None

    @property
    def name(self):
        return self.manifest["name"]

    @property
    def type(self):
        return self.manifest["device"]["type"]

    def fact(self, key):
        for fact in self.manifest["facts"]:
            if fact["key"] == key:
                return fact
        return None


def generation_metadata(directory):
    """Read runtime paths independently of manifest/fact validation."""
    metadata = Path(directory) / "generation.json"
    return json.loads(metadata.read_text()) if metadata.is_file() else None


def load(directory):
    """Read ``bundle.yaml`` (and ``facts.yaml`` when present) from a bundle directory."""
    directory = Path(directory)
    manifest_path = directory / "bundle.yaml"
    if not manifest_path.is_file():
        raise BundleError(f"{manifest_path} not found")
    data = read_yaml(manifest_path)
    try:
        manifest = validate_manifest(data)
    except BundleError as error:
        raise BundleError(f"{manifest_path}: {error}") from None
    facts_path = directory / "facts.yaml"
    facts = read_yaml(facts_path) if facts_path.is_file() else {}
    if not isinstance(facts, dict):
        raise BundleError(f"{facts_path} must contain a mapping")
    validate_ros_facts(facts)
    bundle = Bundle(directory, manifest, facts)
    generation = generation_metadata(directory)
    if generation is not None:
        bundle.device_directory = Path(generation["device_directory"])
        bundle.target_directory = Path(generation["target_directory"])
        bundle.parent_directory = Path(generation["parent_directory"]) if generation.get("parent_directory") else None
    return bundle


def device_name(bundle, facts):
    return facts.get("name") or bundle.name


# Conditions -----------------------------------------------------------------


@total_ordering
class _Version:
    def __init__(self, text):
        self.parts = tuple(int(part) for part in re.findall(r"\d+", str(text)))

    def _other(self, other):
        return other.parts if isinstance(other, _Version) else _Version(other).parts

    def __eq__(self, other):
        return other is not None and self.parts == self._other(other)

    def __lt__(self, other):
        return other is not None and self.parts < self._other(other)


_TOKEN = re.compile(r"\s*(?:(?P<num>\d+(?:\.\d+)?)|(?P<str>'[^']*'|\"[^\"]*\")|(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
                    r"|(?P<op>==|!=|<=|>=|<|>|\(|\)))")


def _tokens(text, path):
    position = 0
    tokens = []
    while position < len(text):
        if text[position:].isspace():
            break
        match = _TOKEN.match(text, position)
        if match is None:
            raise BundleError(f"{path}: unexpected character {text[position]!r} in condition")
        position = match.end()
        if match.group("num") is not None:
            tokens.append(("value", float(match.group("num")) if "." in match.group("num") else int(match.group("num"))))
        elif match.group("str") is not None:
            tokens.append(("value", match.group("str")[1:-1]))
        elif match.group("name") is not None:
            tokens.append(("name", match.group("name")))
        else:
            tokens.append(("op", match.group("op")))
    return tokens


class _Condition:
    """Boolean expression over facts: comparisons, and/or/not, parentheses, version()."""

    def __init__(self, text, path):
        self.path = path
        self.tokens = _tokens(text, path)
        self.position = 0

    def evaluate(self, facts):
        self.position = 0
        value = self._or(facts)
        if self.position != len(self.tokens):
            raise BundleError(f"{self.path}: unexpected {self.tokens[self.position][1]!r} in condition")
        return bool(value)

    def _peek(self, kind, value=None):
        if self.position >= len(self.tokens):
            return False
        token = self.tokens[self.position]
        return token[0] == kind and (value is None or token[1] == value)

    def _take(self):
        if self.position >= len(self.tokens):
            raise BundleError(f"{self.path}: condition ended unexpectedly")
        token = self.tokens[self.position]
        self.position += 1
        return token

    def _or(self, facts):
        value = self._and(facts)
        while self._peek("name", "or"):
            self._take()
            value = self._and(facts) or value
        return value

    def _and(self, facts):
        value = self._not(facts)
        while self._peek("name", "and"):
            self._take()
            value = self._not(facts) and value
        return value

    def _not(self, facts):
        if self._peek("name", "not"):
            self._take()
            return not self._not(facts)
        return self._comparison(facts)

    def _comparison(self, facts):
        left = self._atom(facts)
        if not self._peek("op") or self._peek("op", ")"):
            return left
        operator = self._take()[1]
        right = self._atom(facts)
        if operator == "==":
            return left == right
        if operator == "!=":
            return left != right
        if left is None or right is None:
            return False
        try:
            if operator == "<":
                return left < right
            if operator == "<=":
                return left <= right
            if operator == ">":
                return left > right
            return left >= right
        except TypeError:
            raise BundleError(f"{self.path}: cannot compare {left!r} and {right!r}") from None

    def _atom(self, facts):
        token = self._take()
        if token == ("op", "("):
            value = self._or(facts)
            if self._take() != ("op", ")"):
                raise BundleError(f"{self.path}: missing ) in condition")
            return value
        if token[0] == "value":
            return token[1]
        if token[0] == "name":
            if token[1] == "version":
                if self._take() != ("op", "("):
                    raise BundleError(f"{self.path}: version() needs an argument")
                value = self._atom(facts)
                if self._take() != ("op", ")"):
                    raise BundleError(f"{self.path}: missing ) after version(")
                return None if value is None else _Version(value)
            if token[1] in ("true", "false"):
                return token[1] == "true"
            return facts.get(token[1])
        raise BundleError(f"{self.path}: unexpected {token[1]!r} in condition")


def _compile(text, path):
    return _Condition(text, path)


def evaluate_condition(text, facts, path="condition"):
    return _compile(text, path).evaluate(facts)


# Facts ----------------------------------------------------------------------


def _coerce_int(fact, value, path):
    if isinstance(value, bool):
        raise BundleError(f"{path} must be an integer")
    if isinstance(value, str):
        try:
            value = int(value.strip())
        except ValueError:
            raise BundleError(f"{path} must be an integer") from None
    if not isinstance(value, int):
        raise BundleError(f"{path} must be an integer")
    if fact["min"] is not None and value < fact["min"]:
        raise BundleError(f"{path} must be >= {fact['min']}")
    if fact["max"] is not None and value > fact["max"]:
        raise BundleError(f"{path} must be <= {fact['max']}")
    return value


def _coerce_bool(value, path):
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("true", "yes", "1", "on"):
        return True
    if text in ("false", "no", "0", "off"):
        return False
    raise BundleError(f"{path} must be true or false")


def coerce_fact(fact, value):
    """Coerce one raw fact value by its declared type and constraints."""
    path = f"facts.{fact['key']}"
    kind = fact["type"]
    if kind == "int":
        return _coerce_int(fact, value, path)
    if kind == "bool":
        return _coerce_bool(value, path)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        raise BundleError(f"{path} must be a string")
    if kind == "ip":
        try:
            ipaddress.ip_address(value.strip())
        except ValueError:
            raise BundleError(f"{path} must be an IP address") from None
        value = value.strip()
    if kind == "enum" and value not in fact["enum"]:
        raise BundleError(f"{path} must be one of {', '.join(fact['enum'])}")
    if kind == "path" and not value:
        raise BundleError(f"{path} must be a non-empty path")
    if fact["pattern"] is not None and re.search(fact["pattern"], value) is None:
        raise BundleError(f"{path} must match {fact['pattern']}")
    return value


def detect_ros_distro(bundle):
    """First declared distro present under the ROS root; never guess an unlisted one."""
    root = Path(ros_root())
    if not root.is_dir():
        return None
    for distro in bundle.manifest["ros"]["distros"]:
        if (root / distro).is_dir():
            return distro
    return None


def _default(bundle, fact):
    default = fact["default"]
    if isinstance(default, dict):
        return detect_ros_distro(bundle)
    return default


def _is_required(fact, facts):
    required = fact["required"]
    if isinstance(required, dict):
        return evaluate_condition(required["when"], facts, f"facts.{fact['key']}.required.when")
    return required


def fact_entry(fact):
    default = fact["default"]
    return {"key": fact["key"], "prompt": fact["description"] or fact["key"], "type": fact["type"], "enum": fact["enum"],
            "default": None if isinstance(default, dict) else default}


def validate_facts(bundle, raw):
    """Coerce raw facts, apply defaults and conditional requirements; drop nothing silently."""
    if not isinstance(raw, dict):
        raise BundleError("facts must be a mapping")
    declared = {fact["key"]: fact for fact in bundle.manifest["facts"]}
    for key in raw:
        if key in bundle.manifest["secrets"]:
            raise BundleError(f"{key} is a secret; export it in env.sh, never as a fact")
        if key not in declared:
            raise BundleError(f"facts.{key} is not declared by the bundle")
    facts = {}
    for fact in bundle.manifest["facts"]:
        key = fact["key"]
        value = raw.get(key)
        if value is None or value == "":
            value = _default(bundle, fact)
        if value is None:
            continue
        facts[key] = coerce_fact(fact, value)
    missing = [fact_entry(fact) for fact in bundle.manifest["facts"] if fact["key"] not in facts and _is_required(fact, facts)]
    if missing:
        raise MissingFacts(missing)
    validate_ros_facts(facts)
    return facts


def validate_ros_facts(facts):
    domain = facts.get("domain_id", 0)
    if type(domain) is not int or not 0 <= domain <= 232:
        raise BundleError("facts.domain_id must be an integer between 0 and 232")
    namespace = facts.get("namespace", "")
    if not isinstance(namespace, str) or not re.fullmatch(r"(?:/?[A-Za-z_][A-Za-z0-9_]*(?:/[A-Za-z_][A-Za-z0-9_]*)*|/)?", namespace):
        raise BundleError("facts.namespace must be a valid ROS namespace")


def questionnaire(bundle):
    """Askable facts in manifest order, with the current requirement resolved against defaults."""
    defaults = {fact["key"]: _default(bundle, fact) for fact in bundle.manifest["facts"]}
    known = {key: value for key, value in defaults.items() if value is not None}
    entries = []
    for fact in bundle.manifest["facts"]:
        if not fact["ask"]:
            continue
        entries.append({**fact_entry(fact), "required": _is_required(fact, known)})
    return entries


def redact(facts):
    """Facts for logs: values whose key looks secret are masked."""
    return {key: ("***" if REDACTED.search(key) else value) for key, value in facts.items()}


# Rendering ------------------------------------------------------------------


def _render_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    return str(value)


def render_context(facts):
    return {**{key: _render_value(value) for key, value in facts.items()}, "ros_root": ros_root()}


def render(template, facts):
    """Substitute ``${fact}`` placeholders strictly; unknown names raise BundleError."""
    try:
        return string.Template(template).substitute(render_context(facts))
    except KeyError as error:
        raise BundleError(f"template references unknown fact {error.args[0]!r}: {template!r}") from None
    except ValueError as error:
        raise BundleError(f"invalid placeholder in {template!r}: {error}") from None


def render_tree(value, facts):
    """Render nested templates, preserving fact types for whole-value placeholders."""
    if isinstance(value, str):
        match = string.Template.pattern.fullmatch(value)
        key = (match.group("named") or match.group("braced")) if match else None
        if key is not None and key != "ros_root" and key in facts:
            return copy.deepcopy(facts[key])
        return render(value, facts)
    if isinstance(value, dict):
        return {key: render_tree(entry, facts) for key, entry in value.items()}
    if isinstance(value, list):
        return [render_tree(entry, facts) for entry in value]
    return value
