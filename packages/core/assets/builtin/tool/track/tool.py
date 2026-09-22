#!/usr/bin/env python3
"""Closed loop by composition: perceive, then control on what was perceived."""

from kinex import args, call, finish


def spent(result):
    """Device-clock time a controller round consumed, as it reported it."""
    value = result.get("elapsed_s")
    return float(value) if isinstance(value, (int, float)) else 0.0


def missed(observation):
    """Whether perception explicitly located nothing this round.

    Only a result that carries a null `point` is a miss. An observation with no
    `point` at all is a different kind of perception — an image bundle for a
    policy, say — and misses do not apply to it.
    """
    return "point" in observation and observation["point"] is None


def control(a):
    perceive, controller, until = a["perceive"], a["control"], a.get("until")
    budget, allowed = a["timeout_s"], a.get("max_misses", 3)
    ceiling, settle = a.get("max_rounds", 200), a.get("stop_when_reached", True)
    elapsed, rounds, misses, reason, last = 0.0, 0, 0, None, None
    while reason is None:
        rounds += 1
        observation = call(perceive["tool"], **(perceive.get("args") or {}))
        if missed(observation):
            misses += 1
            # Nothing to steer by: perceive again rather than command blindly.
            reason = "perception_lost" if misses >= allowed else None
        else:
            misses = 0
            last = call(controller["tool"], **(controller.get("args") or {}), observation=observation)
            elapsed += spent(last)
            if last.get("terminated_by") == "fault":
                reason = "fault"
            elif settle and last.get("reached"):
                reason = "reached"
            elif until and call(until["tool"], **(until.get("args") or {})).get(until.get("key", "done")):
                reason = "until:" + until["tool"]
            elif elapsed >= budget:
                reason = "timeout"
        if reason is None and rounds >= ceiling:
            reason = "max_rounds"
    return {"reached": reason == "reached", "terminated_by": reason, "rounds": rounds,
            "elapsed_s": round(elapsed, 4), "perception_misses": misses, "last": last}


if __name__ == "__main__":
    finish(control(args()))
