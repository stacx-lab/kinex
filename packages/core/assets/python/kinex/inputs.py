"""Map tool results into call arguments with JSON Pointers."""

from copy import deepcopy
import re


def parts(pointer):
    if not isinstance(pointer, str) or pointer and not pointer.startswith("/"):
        raise ValueError("input paths must be JSON Pointers")
    if re.search(r"~(?![01])", pointer):
        raise ValueError(f"invalid JSON Pointer: {pointer}")
    return [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")] if pointer else []


def index(key):
    if not re.fullmatch(r"0|[1-9][0-9]*", key):
        raise ValueError(f"invalid array index: {key}")
    return int(key)


def select(value, pointer):
    for key in parts(pointer):
        try:
            value = value[index(key)] if isinstance(value, list) else value[key]
        except (KeyError, IndexError, TypeError) as error:
            raise ValueError(f"missing input path: {pointer}") from error
    return value


def assign(target, pointer, value):
    keys = parts(pointer)
    if not keys:
        raise ValueError("input destination must name an argument")
    for position, key in enumerate(keys):
        last = position == len(keys) - 1
        child = deepcopy(value) if last else ([] if keys[position + 1].isdigit() else {})
        if isinstance(target, dict):
            if last:
                target[key] = child
            else:
                target = target.setdefault(key, child)
        elif isinstance(target, list):
            offset = index(key)
            if offset == len(target):
                target.append(child)
            elif offset > len(target):
                raise ValueError(f"missing destination index: {pointer}")
            if last:
                target[offset] = child
            else:
                target = target[offset]
        else:
            raise ValueError(f"input destination is not a container: {pointer}")


def arguments(spec, previous, *, observation=False):
    result = deepcopy(spec.get("args", {}))
    if "inputs" not in spec:
        if observation:
            return {**result, "observation": previous}
        if previous is None:
            return None
        if not isinstance(previous, dict):
            raise ValueError("process must return a dict or null")
        return {**result, **previous}
    values = [(destination, select(previous, source)) for destination, source in spec["inputs"].items()]
    for destination, _ in values:
        if not parts(destination):
            raise ValueError("input destination must name an argument")
    if any(value is None for _, value in values):
        return None
    for destination, value in values:
        assign(result, destination, value)
    return result
