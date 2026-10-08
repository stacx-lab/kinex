"""Plain message classes with ROS-like field specs, JSON conversion and defaults."""

import array


class Message:
    __slots__ = ()
    FIELDS = ()
    TYPE = ""

    def __init__(self, **values):
        for name, spec in self.FIELDS:
            setattr(self, name, values.pop(name) if name in values else _default(spec))
        if values:
            raise TypeError(f"{self.TYPE} has no fields {sorted(values)}")

    def __eq__(self, other):
        return type(other) is type(self) and all(getattr(self, n) == getattr(other, n) for n, _ in self.FIELDS)

    def __repr__(self):
        inner = ", ".join(f"{name}={getattr(self, name)!r}" for name, _ in self.FIELDS)
        return f"{self.TYPE}({inner})"

    @classmethod
    def get_fields_and_field_types(cls):
        return {name: _spec_name(spec) for name, spec in cls.FIELDS}


def _default(spec):
    if isinstance(spec, list):
        return []
    if isinstance(spec, type) and issubclass(spec, Message):
        return spec()
    return spec()


def _spec_name(spec):
    if isinstance(spec, list):
        return f"sequence<{_spec_name(spec[0])}>"
    if isinstance(spec, type) and issubclass(spec, Message):
        return spec.TYPE
    return {float: "double", int: "int64", str: "string", bool: "boolean", bytes: "uint8"}[spec]


def define(type_name, fields):
    """Create a message class named pkg/msg/Name with [(field, spec)] where a
    spec is float/int/str/bool, a Message class, or a one-element list of those."""
    name = type_name.rsplit("/", 1)[-1]
    namespace = {"__slots__": tuple(f for f, _ in fields), "FIELDS": tuple(fields), "TYPE": type_name}
    return type(name, (Message,), namespace)


def to_dict(message):
    if isinstance(message, Message):
        return {name: to_dict(getattr(message, name)) for name, _ in message.FIELDS}
    if isinstance(message, (list, tuple, array.array)):
        return [to_dict(item) for item in message]
    if isinstance(message, (bytes, bytearray)):
        return list(message)
    return message


def from_dict(cls, data):
    if isinstance(data, cls):
        return data
    if not isinstance(data, dict):
        raise TypeError(f"{cls.TYPE} expects an object, got {type(data).__name__}")
    unknown = set(data) - {name for name, _ in cls.FIELDS}
    if unknown:
        raise TypeError(f"{cls.TYPE} has no fields {sorted(unknown)}")
    return cls(**{name: _convert(spec, data[name]) for name, spec in cls.FIELDS if name in data})


def _convert(spec, value):
    if isinstance(spec, list):
        return [_convert(spec[0], item) for item in value]
    if isinstance(spec, type) and issubclass(spec, Message):
        return from_dict(spec, value)
    return spec(value)
