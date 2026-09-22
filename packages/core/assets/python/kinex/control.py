"""One controller loop for every builtin control tool.

A write sets the goal, executes it, and reports the simulator time it actually
spent: one control interval where the write is what advances physics, the whole
motion where a background clock does. Every duration a tool states is in that
clock, so the loop below is the same code on every backend and differs only in
how many times it goes round. Nothing here sleeps, and nothing polls — the write
returns the resulting state, so a segment costs exactly one round trip.
"""

from contextlib import contextmanager

from kinex import call, device, devices
from kinex.validation import number, segment_result


def read(name):
    """One reading, for the verification a write's own report cannot provide."""
    state = device(name).get("data") or {}
    if not isinstance(state.get("faults"), list):
        raise ValueError(f"{name} read.faults must be a list")
    return state


def stamp(state):
    """A reading's acquisition time, falling back to its receipt time."""
    value = state.get("sample_time_s")
    return number(state.get("received_time_s") if value is None else value, "read timestamp")


def execute(name, commands, budget_s):
    """Run every commanded goal for up to `budget_s` of device time.

    `commands` maps device name to write arguments, so one action reaches a whole
    embodiment at once and the devices execute concurrently. The outcome reported
    is `name`'s: how long it ran, whether it arrived, and the state it ended in.
    """
    batch = [{"device": target, "action": "write", "args": {**payload, "for_s": budget_s}}
             for target, payload in commands.items()]
    outcomes = {}
    results = devices(batch)
    if len(results) != len(batch):
        raise ValueError("write batch returned an incomplete result")
    for target, result in zip(commands, results):
        if not result.get("ok"):
            raise ValueError(f"write to {target} failed: {result.get('error', 'unknown error')}")
        outcomes[target] = segment_result(result.get("data"))
    return {**outcomes[name], "faulted_devices": [target for target, result in outcomes.items()
                                                if result["state"]["faults"]]}


def stop_all(names):
    """Attempt every stop, including when an earlier device refuses to stop."""
    errors = []
    for name in dict.fromkeys(names):
        try:
            device(name, "stop")
        except Exception as error:
            errors.append(f"{name}: {error}")
    if errors:
        raise RuntimeError("stop failed: " + "; ".join(errors))


@contextmanager
def stop_on_error(names):
    """Retain the original failure while making any cleanup failure visible."""
    try:
        yield
    except BaseException as error:
        try:
            stop_all(names)
        except Exception as cleanup:
            error.add_note(str(cleanup))
        raise


def predicate(until):
    result = call(until["tool"], **(until.get("args") or {}))
    return "until:" + until["tool"] if result.get(until.get("key", "done")) else None


def run(name, command, *, until=None, timeout_s=30.0,
        on_timeout="stop", finish_when_reached=True):
    """Execute a fixed goal, optionally checking a predicate between segments.

    The command is validated once by the caller. Each write changes only for_s;
    predicate deadlines are the only reason to split a device-owned segment.
    """
    elapsed, rounds, state = 0.0, 0, None
    period = number(until.get("every_s", 1.0), "until.every_s") if until else None
    if period is not None and period <= 0:
        raise ValueError("until.every_s must be positive")
    next_check = period
    with stop_on_error([name]):
        reason = predicate(until) if until else None
        while reason is None:
            budget = timeout_s - elapsed
            if until:
                budget = min(budget, next_check - elapsed)
            outcome = execute(name, {name: command}, budget)
            elapsed, state, rounds = elapsed + outcome["elapsed_s"], outcome["state"], rounds + 1
            if outcome["faulted_devices"]:
                reason = "fault"
            else:
                if until and (elapsed + 1e-9 >= next_check or elapsed + 1e-9 >= timeout_s
                              or (finish_when_reached and outcome["reached"])):
                    reason = predicate(until)
                    next_check = elapsed + period
                if reason is None:
                    if finish_when_reached and outcome["reached"]:
                        reason = "reached"
                    elif elapsed + 1e-9 >= timeout_s:
                        reason = "timeout"
                    elif outcome["elapsed_s"] <= 0:
                        reason = "stalled"
    if reason != "timeout" or on_timeout != "continue":
        stop_all([name])
    return {"terminated_by": reason, "rounds": rounds, "elapsed_s": elapsed,
            "state": state}
