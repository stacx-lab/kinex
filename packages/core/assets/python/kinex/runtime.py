"""Read-only discovery. Results stay in Python unless selected with finish()."""
import re


def devices():
    """Configured devices and host-known readiness; never starts or probes nodes."""
    from kinex import _rpc
    return _rpc({"call": "runtime_devices"})["result"]


def device(name):
    """One device's general description and host-known state, even when unloaded."""
    from kinex import _rpc
    return _rpc({"call": "runtime_device", "device": name})["result"]


def operations(device):
    """Declared operation metadata, including on unloaded devices."""
    from kinex import _rpc
    return _rpc({"call": "runtime_operations", "device": device})["result"]


def describe(operation):
    """One operation's protocol and recursive ROS payload definitions; no ROS init."""
    from kinex.errors import RPCError
    device, separator, name = operation.partition(".")
    if not separator:
        raise ValueError("operation must be device.operation")
    catalog = operations(device)
    if name not in catalog:
        raise ValueError(f"unknown operation {operation}; available: {', '.join(catalog)}")
    spec = catalog[name]
    try:
        from rosidl_runtime_py.utilities import get_message, get_service
        definitions = {}

        def fields(cls):
            result = dict(cls.get_fields_and_field_types())
            for field_type in result.values():
                for package, message in re.findall(r"\b([A-Za-z]\w*)/(?:msg/)?([A-Za-z]\w*)", field_type):
                    reference = f"{package}/msg/{message}"
                    if reference not in definitions:
                        definitions[reference] = {}
                        definitions[reference] = fields(get_message(reference))
            return result

        if spec["transport"] == "service":
            cls = get_service(spec["type"])
            payload = {"request": fields(cls.Request), "response": fields(cls.Response)}
        else:
            payload = {"message": fields(get_message(spec["type"]))}
        return {**spec, **payload, "definitions": definitions}
    except (ImportError, AttributeError) as error:
        raise RPCError(f"Kinex Python is missing interface {spec['type']}; prepare its ROS environment and interface packages.",
                       code="interface_unavailable", details={"operation": operation, "type": spec["type"]}) from error
