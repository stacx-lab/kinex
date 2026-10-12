#!/usr/bin/env python3
"""Compose observation, control, world time and a stateful predicate."""

from kinex import args, call, device, finish, inline, stop_owned
from kinex.control import stop_on_error
from kinex.inputs import arguments


def stage(spec, values, *, kind="perception"):
    if spec is None:
        return {}
    if "python" in spec:
        return inline(spec["python"], values, kind=kind)
    return call(spec["tool"], **values)


def control(a):
    perceive, process, controller, until = (a.get(key) for key in ("perceive", "process", "control", "until"))
    world = a["world"]
    rounds, misses, last, predicate_state = 0, 0, None, None
    context = {"round": 0, "observation": None, "control_args": (controller or {}).get("args", {}),
               "control_result": None, "world": world}

    def check():
        nonlocal predicate_state
        context["time_s"] = device(world)["time_s"]
        result = stage(until, {**(until or {}).get("args", {}), "context": context, "state": predicate_state})
        if not isinstance(result, dict) or not isinstance(result.get("done", False), bool):
            raise ValueError("until must return a dict with optional done: boolean")
        predicate_state = result.get("state")
        return (result.get("reason") or "until") if result.get("done", False) else None

    with stop_on_error():
        reason = check()
        while reason is None:
            rounds += 1
            observation = stage(perceive, (perceive or {}).get("args", {}))
            process_args = arguments(process or {}, observation, observation=True)
            processed = None if process_args is None else stage(process, process_args)
            if processed is not None and not isinstance(processed, dict):
                raise ValueError("process must return a dict or null")
            values = None if processed is None else arguments(controller or {}, processed)
            context.update(round=rounds, observation=observation, control_args=None, control_result=None)
            if values is None:
                stop_owned()
                misses += 1
                if misses >= a.get("max_misses", 3):
                    reason = "perception_lost"
            else:
                misses = 0
                last = stage(controller, values, kind="controller")
                context.update(control_args=values, control_result=last)
            device(world, "wait", {"duration_s": a["wait_s"]})
            if a.get("stop_after_control", False):
                stop_owned()
            reason = check() or reason
            if reason is None and rounds >= a.get("max_rounds", 200):
                reason = "max_rounds"
        stop_owned()
    return {"terminated_by": reason, "rounds": rounds, "perception_misses": misses,
            "last": last, "until_state": predicate_state}


if __name__ == "__main__":
    finish(control(args()))
