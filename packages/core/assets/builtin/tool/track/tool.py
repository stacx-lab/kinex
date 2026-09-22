#!/usr/bin/env python3
"""Re-perceive a point between bounded move_to segments."""

from kinex import args, call, finish, profile
from kinex.control import predicate, stop_all, stop_on_error
from kinex.validation import number


def control(a):
    perceive, controller, until = a["perceive"], a["control"], a.get("until")
    if controller["tool"] != "move_to":
        raise ValueError("track supports only move_to")
    move = controller["args"]
    if set(move) & {"joints", "pose", "observation", "until"}:
        raise ValueError("track supplies the observation and owns its predicate")
    name = move["device"]
    prof = profile(name)
    if prof.get("type") != "joint" or not prof.get("loaded"):
        raise ValueError("track requires a loaded joint device")
    budget, segment = a["timeout_s"], move["timeout_s"]
    allowed, ceiling = a.get("max_misses", 3), a.get("max_rounds", 200)
    elapsed, rounds, misses, reason, last = 0.0, 0, 0, None, None
    with stop_on_error([name]):
        reason = predicate(until) if until else None
        while reason is None:
            rounds += 1
            observation = call(perceive["tool"], **(perceive.get("args") or {}))
            if "point" not in observation:
                raise ValueError("track perception must return a point or point: null")
            if observation["point"] is None:
                stop_all([name])
                misses += 1
                if misses >= allowed:
                    reason = "perception_lost"
            else:
                misses = 0
                remaining = min(segment, budget - elapsed)
                last = call("move_to", **{**move, "timeout_s": remaining, "observation": observation})
                spent = number(last.get("elapsed_s"), "move_to.elapsed_s")
                if spent < 0 or spent > remaining + 1e-9:
                    raise ValueError("move_to elapsed time exceeds its segment budget")
                elapsed += spent
                child_reason = last.get("terminated_by")
                if child_reason in ("fault", "stalled", "disturbed"):
                    reason = child_reason
                elif child_reason not in ("reached", "timeout"):
                    raise ValueError(f"unexpected move_to termination: {child_reason}")
                elif a.get("stop_when_reached", True) and last.get("reached"):
                    reason = "reached"
                elif elapsed + 1e-9 >= budget:
                    reason = "timeout"
                elif spent <= 0 and not last.get("reached"):
                    reason = "stalled"
            if until and reason not in ("fault", "stalled", "disturbed"):
                reason = predicate(until) or reason
            if reason is None and rounds >= ceiling:
                reason = "max_rounds"
    stop_all([name])
    return {"reached": reason == "reached", "terminated_by": reason, "rounds": rounds,
            "elapsed_s": elapsed, "perception_misses": misses, "last": last}


if __name__ == "__main__":
    finish(control(args()))
