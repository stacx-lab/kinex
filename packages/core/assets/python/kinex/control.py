"""One controller loop for every builtin control tool.

A write sets the goal, executes it, and reports the simulator time it actually
spent: one control interval where the write is what advances physics, the whole
motion where a background clock does. Every duration a tool states is in that
clock, so the loop below is the same code on every backend and differs only in
how many times it goes round. Nothing here sleeps, and nothing polls — the write
returns the resulting state, so a segment costs exactly one round trip.
"""

from kinex import call, device, devices
from kinex.frames import pose as frame_pose
from kinex.geometry import apply_rt, pose_to_rt
from kinex.validation import number, vector


def read(name):
    """One reading, for the verification a write's own report cannot provide."""
    state = device(name).get("data") or {}
    return checked_state(name, state)


def stamp(state):
    """A reading's acquisition time, falling back to its receipt time."""
    value = state.get("sample_time_s")
    return number(state.get("received_time_s") if value is None else value, "read timestamp")


def checked_state(name, state):
    if not isinstance(state.get("faults"), list):
        raise ValueError(f"{name} read.faults must be a list")
    return state


def execute(name, commands, budget_s):
    """Run every commanded goal for up to `budget_s` of device time.

    `commands` maps device name to write arguments, so one action reaches a whole
    embodiment at once and the devices execute concurrently. The outcome reported
    is `name`'s: how long it ran, whether it arrived, and the state it ended in.
    """
    batch = [{"device": target, "action": "write", "args": {**payload, "for_s": budget_s}}
             for target, payload in commands.items()]
    outcome = None
    for target, result in zip(commands, devices(batch)):
        if not result.get("ok"):
            raise ValueError(f"write to {target} failed: {result.get('error', 'unknown error')}")
        data = result.get("data") or {}
        if data.get("accepted") is not True:
            raise ValueError(f"write to {target} must acknowledge accepted: true")
        if target == name:
            outcome = data
    if number(outcome.get("elapsed_s"), f"{name} write.elapsed_s") < 0:
        raise ValueError(f"{name} write.elapsed_s must not be negative")
    return {**outcome, "state": checked_state(name, outcome.get("state") or {})}


def point_in(name, observation, frame=None):
    """A perception result's point, expressed in `name`'s canonical frame.

    None means the observation located nothing, which a caller treats as a miss
    and not a failure: a detector that blinks should not abandon a motion.
    """
    point = (observation or {}).get("point")
    if point is None:
        return None
    frame = frame or observation.get("frame")
    if not frame:
        raise ValueError("the observation names no frame for its point; supply frame")
    measured = vector(point, 3, "located point")
    if frame == name:
        return measured
    return apply_rt(pose_to_rt(frame_pose(frame, name)), measured)


def predicate(until, elapsed, checked):
    """Run an `until` perception tool at most every until.every_s of device time."""
    if not until or elapsed - checked[0] < number(until.get("every_s", 1.0), "until.every_s"):
        return None
    checked[0] = elapsed
    result = call(until["tool"], **(until.get("args") or {}))
    return "until:" + until["tool"] if result.get(until.get("key", "done")) else None


def run(name, prof, *, target, write, until=None, timeout_s=30.0,
        on_timeout="stop", misses=3, stop=None):
    """Pursue a goal until the device says it arrived, or the budget is spent.

    target(round, state) -> the goal for this round, or None to keep the previous
      one (a perception miss; `misses` consecutive ones end the run).
    write(goal)          -> {device: write arguments} for every device to command.

    One round is one write. A device with a background clock spends the whole
    motion in a single call; one that advances inside the write spends an
    interval per call. `on_timeout="continue"` leaves the goal standing on the
    way out, so motion carries on while the caller thinks; the default stops.
    """
    halts = stop or [name]
    elapsed, goal, lost, rounds = 0.0, None, 0, 0
    reason, state, checked = None, None, [0.0]
    try:
        while reason is None:
            fresh = target(rounds, state)
            if fresh is None:
                lost += 1
                if goal is None or lost >= misses:
                    reason = "goal_lost"
                    break
            else:
                goal, lost = fresh, 0
            outcome = execute(name, write(goal), timeout_s - elapsed)
            elapsed, state, rounds = elapsed + outcome["elapsed_s"], outcome["state"], rounds + 1
            if state["faults"]:
                reason = "fault"
            elif outcome.get("reached"):
                reason = "reached"
            elif elapsed >= timeout_s:
                reason = "timeout"
            else:
                reason = predicate(until, elapsed, checked)
                if reason is None and outcome["elapsed_s"] <= 0:
                    # A device that reports no progress will not make any later.
                    reason = "stalled"
    except BaseException:
        # The harness stops every device when a controller fails, so this is
        # belt and braces: it must never replace the error that caused the exit.
        for halted in halts:
            try:
                device(halted, "stop")
            except Exception:
                pass
        raise
    # "continue" deliberately leaves the goal standing so motion carries on while
    # the caller perceives. A fault ends that privilege.
    if reason == "fault" or on_timeout != "continue":
        for halted in halts:
            device(halted, "stop")
    return {"terminated_by": reason, "rounds": rounds, "goal_misses": lost,
            "elapsed_s": elapsed, "state": state, "goal": goal}
