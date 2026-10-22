"""Device-side managed motion: owner generations, admission status and owner-scoped stop."""
from collections import OrderedDict

from kinex.communication import qos


class Ownership:
    """Generations per owner; a newer owner replaces older ones and stop invalidates all."""

    def __init__(self):
        self.counter = 0
        self.active = None
        self.issued = OrderedDict()
        self.floor = 0

    def acquire(self, owner):
        if not owner:
            raise ValueError("owner must be nonempty")
        if owner not in self.issued:
            self.counter += 1
            self.issued[owner] = self.counter
            if len(self.issued) > 256:
                self.issued.popitem(last=False)
        return self.issued[owner]

    def validate(self, owner, generation):
        if self.issued.get(owner) != generation or generation <= self.floor:
            raise ValueError("command ownership was invalidated; start a new invocation")
        if self.active and generation < self.active[1]:
            raise ValueError("command was replaced by a newer owner")

    def accept(self, owner, generation):
        self.active = (owner, generation)

    def stop(self, owner=""):
        """Owner-scoped stop cannot stop a newer owner; an empty owner always stops."""
        if owner:
            self.issued.pop(owner, None)
            if not self.active or self.active[0] != owner:
                return False
        self.invalidate()
        return True

    def invalidate(self):
        self.floor = self.counter
        self.issued.clear()
        self.active = None


def motion_service(node, operation, apply, hold):
    """Serve a managed input topic: apply(message) admits a command or raises to reject it,
    and hold() keeps the actuator at its measured posture after an accepted stop."""
    from kinex_interfaces.msg import CommandStatus
    from kinex_interfaces.srv import Acquire, Stop
    from rclpy.qos import DurabilityPolicy, QoSProfile
    from rosidl_runtime_py.utilities import get_message

    ownership, motion = Ownership(), operation["motion"]
    status = node.create_publisher(CommandStatus, motion["status"],
                                   QoSProfile(depth=64, durability=DurabilityPolicy.TRANSIENT_LOCAL))

    def acquire(request, response):
        try:
            response.generation, response.success = ownership.acquire(request.owner), True
        except ValueError as error:
            response.message = str(error)
        return response

    def submit(message):
        result = CommandStatus(owner=message.owner, generation=message.generation, command_id=message.command_id)
        # Rejections are statuses; they must not stop the node's executor.
        try:
            if not message.command_id:
                raise ValueError("command_id must be nonempty")
            ownership.validate(message.owner, message.generation)
            apply(message)
            ownership.accept(message.owner, message.generation)
            result.accepted, result.state, result.message = True, "accepted", "reference accepted; verify measured feedback"
        except Exception as error:
            result.state, result.message = "rejected", str(error)
        status.publish(result)

    def stop(request, response):
        response.stopped = ownership.stop(request.owner)
        if response.stopped:
            hold()
        response.success = True
        response.message = "hold applied" if response.stopped else "owner already replaced"
        return response

    node.create_subscription(get_message(operation["type"]), operation["endpoint"], submit, qos(operation))
    node.create_service(Acquire, motion["acquire"], acquire)
    node.create_service(Stop, motion["stop"], stop)
    return ownership
