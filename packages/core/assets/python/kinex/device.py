"""A device as a program holds it: its profile, and its topics, services and actions by the names it declares."""
from kinex.communication import scope


def described(spec):
    """An operation's description and declaration with its ROS interface (kinex.common.interfaces), or, where
    Kinex Python lacks the interface, error saying so."""
    from kinex.common.interfaces import interface
    try:
        found = interface(spec["type"])
    except (ImportError, AttributeError, ValueError) as error:
        found = {"error": f"Kinex Python lacks interface {spec['type']}: {error}"}
    return {key: spec[key] for key in ("description", "transport", "direction", "type")} | found


class Topic:
    """A device's topic. An output is read: next() is its next message, latest the last one received and
    `async for` follows it; close() releases it until it is read again. An input is commanded with publish()."""

    def __init__(self, scope, reference, spec, depth):
        self.scope, self.reference, self.spec, self.depth, self.stream = scope, reference, spec, depth, None

    def _stream(self):
        if self.spec["direction"] != "output":
            raise TypeError(f"{self.reference} is not a device output")
        if self.stream is None or self.stream.closed:
            self.stream = self.scope.subscribe(self.spec, self.depth)
        return self.stream

    def next(self, *, timeout_s=None):
        """The next message; timeout_s defaults to the operation's. A topic that retains its last message gives
        that one when none is unread, so a paused world can be read. Reading never advances world time."""
        stream = self._stream()
        if self.spec.get("qos", {}).get("durability") == "transient_local" and not stream.buffer and stream.latest is not None:
            kept = stream.latest
            stream.close()  # a new subscription is sent the retained message
            self._stream().latest = kept
        return self._stream().next(timeout_s=self.spec.get("timeout_s", 10) if timeout_s is None else timeout_s)

    @property
    def latest(self):
        return self._stream().latest

    def __aiter__(self):
        return self

    def __anext__(self):
        return self._stream().next()

    def close(self):
        if self.stream is not None:
            self.stream.close()

    def publish(self, message):
        """Send one message, a ROS message or field mapping, once the device is listening. Sending is not arrival."""
        return self.scope.publish(self.reference, message)

    def describe(self):
        """Its description and declaration with its ROS interface."""
        return described(self.spec)


class Service:
    """A device's service: call it with its request's fields and await the response, or a Json operation's decoded
    object. A rejection raises kinex.OperationError."""

    def __init__(self, scope, reference, spec):
        self.scope, self.reference, self.spec = scope, reference, spec

    def __call__(self, *args, **fields):
        return self.scope.request(self.reference, *args, **fields)

    def describe(self):
        """Its description and declaration with its ROS interface."""
        return described(self.spec)


class Action(Service):
    """A device's action: call it with a goal's fields for the Goal, already sent."""

    def __call__(self, *args, **fields):
        return self.scope.act(self.reference, *args, **fields)


class Device:
    def __init__(self, scope, name):
        self.scope, self.name, self._profile = scope, name, None

    @property
    def profile(self):
        """Its parsed profile.yaml, loaded or not, with its URDF model resolved: the facts lib functions compute
        with, such as frames, color geometry and the model."""
        if self._profile is None:
            from kinex import _rpc
            self._profile = _rpc({"call": "profile", "device": self.name})["profile"]
        return self._profile

    def describe(self):
        """Its description and each operation it declares, loaded or not, described as the operation's own describe()
        describes it."""
        return {"description": self.profile["description"],
                "operations": {name: described(spec) for name, spec in self.profile["operations"].items()}}

    def topic(self, name, *, depth=None):
        """The topic the device declares as name; depth is how many unread messages it keeps."""
        reference = f"{self.name}.{name}"
        spec, topics = self.scope.operation(reference, "topic"), self.scope.topics
        if (reference, depth) not in topics:
            topics[reference, depth] = Topic(self.scope, reference, spec, depth)
        return topics[reference, depth]

    def service(self, name):
        """The service the device declares as name."""
        reference = f"{self.name}.{name}"
        return Service(self.scope, reference, self.scope.operation(reference, "service"))

    def action(self, name):
        """The action the device declares as name."""
        reference = f"{self.name}.{name}"
        return Action(self.scope, reference, self.scope.operation(reference, "action"))


def device(name):
    """A device by name, such as device("arm"): its profile and description, and the operations of a loaded one.

    Example: state = await device("arm").topic("joint_state").next()
    """
    return Device(scope(), name)
