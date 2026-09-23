#!/usr/bin/env python3
"""Repeat perception, argument processing and bounded control."""

from kinex import args, call, finish, stop_owned
from kinex.control import predicate, stop_on_error


def control(a):
    perceive, process, controller = a["perceive"], a["process"], a["control"]
    until = a.get("until")
    rounds, misses, last = 0, 0, None
    with stop_on_error():
        reason = predicate(until) if until else None
        while reason is None:
            rounds += 1
            observation = call(perceive["tool"], **(perceive.get("args") or {}))
            processed = call(process["tool"], **{**(process.get("args") or {}), "observation": observation})
            if (not isinstance(processed, dict) or "args" not in processed or
                    processed["args"] is not None and not isinstance(processed["args"], dict)):
                raise ValueError("process must return {args: object} or {args: null}")
            if processed["args"] is None:
                stop_owned()
                misses += 1
                if misses >= a.get("max_misses", 3):
                    reason = "perception_lost"
            else:
                misses = 0
                last = call(controller["tool"], **{**(controller.get("args") or {}), **processed["args"]})
            if until:
                reason = predicate(until) or reason
            if reason is None and rounds >= a.get("max_rounds", 200):
                reason = "max_rounds"
    stop_owned()
    return {"terminated_by": reason, "rounds": rounds, "perception_misses": misses, "last": last}


if __name__ == "__main__":
    finish(control(args()))
