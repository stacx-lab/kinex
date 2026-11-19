"""Building blocks for device nodes: names, placement, commands and JSON services."""
import json
import re

from kinex.communication import qos


def node_name(profile, suffix=""):
    """A legal ROS node name for the device: kinex_<name>[_<suffix>] with other characters as _."""
    return re.sub(r"[^A-Za-z0-9_]", "_", "_".join(filter(None, ("kinex", profile["name"], suffix))))


def placement(compute, supported=("cpu", "cuda", "mps")):
    """The torch device string for a model's declared compute."""
    if compute["kind"] not in supported:
        raise ValueError(f"this model runs on {' or '.join(supported)}, not {compute['kind']}")
    return f"cuda:{compute['index']}" if compute["kind"] == "cuda" else compute["kind"]


def command_service(node, operations, commands, hold):
    """Route input topics to their handlers and serve the device's Trigger stop as hold().

    commands maps each operation name to apply(message), which forwards the command
    or raises to reject it; hold() keeps the actuator at its measured posture. A
    rejection is logged and never stops the node's executor.
    """
    from rosidl_runtime_py.utilities import get_message
    from std_srvs.srv import Trigger

    def submit(name, apply, message):
        try:
            apply(message)
        except Exception as error:
            node.get_logger().warning(f"{name} rejected: {error}")

    def stop(request, response):
        try:
            hold()
            response.success = True
        except Exception as error:
            response.message = f"{type(error).__name__}: {error}"
        return response

    for name, apply in commands.items():
        operation = operations[name]
        node.create_subscription(get_message(operation["type"]), operation["endpoint"],
                                 lambda message, name=name, apply=apply: submit(name, apply, message), qos(operation))
    # Senders discover stop before commanding, so it must follow the subscriptions.
    node.create_service(Trigger, operations["stop"]["endpoint"], stop)


def json_service(node, operation, handler):
    """Serve handler(**request) -> dict on an owned node's Json operation."""
    from custom_interfaces.srv import Json

    def call(request, response):
        # Handler failures are responses; they must not stop the node's executor.
        try:
            response.response = json.dumps(handler(**json.loads(request.request)), allow_nan=False)
            response.success = True
        except Exception as error:
            response.message = f"{type(error).__name__}: {error}"
        return response
    return node.create_service(Json, operation["endpoint"], call)

