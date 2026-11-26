"""ROS interfaces as data, read from their definitions without starting ROS.

Run as a module, it reads a JSON list of interface types and writes {type: its interface, or {"error": why}}.
"""
import json
import re
import sys

NESTED = re.compile(r"\b([A-Za-z]\w*)/([A-Za-z]\w*)\b")


def interface(type):
    """{"interface": fields by part, "types": fields of each message they nest, once}: a msg type's message, a srv
    type's request and response, an action type's goal, result and feedback. Field types read as ROS gives them,
    nested messages as package/Name."""
    from rosidl_runtime_py.utilities import get_action, get_message, get_service
    nested = {}

    def fields(cls):
        result = dict(cls.get_fields_and_field_types())
        for value in result.values():
            for package, name in NESTED.findall(value):
                if f"{package}/{name}" not in nested:
                    nested[f"{package}/{name}"] = {}
                    nested[f"{package}/{name}"] = fields(get_message(f"{package}/msg/{name}"))
        return result

    kind = type.split("/")[1]
    if kind == "srv":
        cls = get_service(type)
        parts = {"request": fields(cls.Request), "response": fields(cls.Response)}
    elif kind == "action":
        cls = get_action(type)
        parts = {"goal": fields(cls.Goal), "result": fields(cls.Result), "feedback": fields(cls.Feedback)}
    else:
        parts = {"message": fields(get_message(type))}
    return {"interface": parts, "types": nested}


if __name__ == "__main__":
    found = {}
    for name in json.load(sys.stdin):
        try:
            found[name] = interface(name)
        except Exception as error:
            found[name] = {"error": str(error) or type(error).__name__}
    json.dump(found, sys.stdout)
