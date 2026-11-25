"""A loaded device as a program holds it: its topics, services and actions, by the names its profile declares."""
from functools import partial

from kinex.communication import scope


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


class Device:
    def __init__(self, scope, name):
        self.scope, self.name = scope, name

    @property
    def operations(self):
        """The device's loaded operations: name -> its profile's declaration."""
        return {reference.split(".", 1)[1]: spec for reference, spec in self.scope.catalog.items()
                if reference.split(".", 1)[0] == self.name}

    def topic(self, name, *, depth=None):
        """The topic the device declares as name; depth is how many unread messages it keeps."""
        reference = f"{self.name}.{name}"
        spec, topics = self.scope.operation(reference, "topic"), self.scope.topics
        if (reference, depth) not in topics:
            topics[reference, depth] = Topic(self.scope, reference, spec, depth)
        return topics[reference, depth]

    def service(self, name):
        """The service the device declares as name: call it with its request's fields and await the response,
        or a Json operation's decoded object. A rejection raises kinex.OperationError."""
        reference = f"{self.name}.{name}"
        self.scope.operation(reference, "service")
        return partial(self.scope.request, reference)

    def action(self, name):
        """The action the device declares as name: call it with a goal's fields for the Goal, already sent."""
        reference = f"{self.name}.{name}"
        self.scope.operation(reference, "action")
        return partial(self.scope.act, reference)


def device(name):
    """A loaded device by name, such as device("arm"), to reach its operations through.

    Example: state = await device("arm").topic("joint_state").next()
    """
    return Device(scope(), name)
