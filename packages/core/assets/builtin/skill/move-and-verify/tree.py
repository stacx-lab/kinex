#!/usr/bin/env python3
"""A cooperative py_trees skill, executed by Kinex's Python controller harness."""

from collections import deque
from functools import partial
from pathlib import Path

import py_trees
from py_trees.parsers.behaviour_tree_xml import parse_behaviour_tree_xml
from py_trees.ports import BehaviourWithPorts

from kinex import RPCError, args, call, device, finish, profile, stop_owned
from kinex.control import read, stop_on_error
from kinex.joint_control import Arrival
from kinex.motion import joint_target, vector
from kinex.validation import number

Status = py_trees.common.Status


class Action(BehaviourWithPorts):
    """Queue one synchronous operation for the runner, outside update()."""

    INPUT_PORTS = {}
    OUTPUT_PORTS = {}

    def __init__(self, name, operation, **kwargs):
        super().__init__(name=name, **kwargs)
        self.operation = operation
        self.pending = False
        self.result = None

    def initialise(self):
        self.pending, self.result = False, None

    def update(self):
        if self.result is None:
            self.pending = True
            return Status.RUNNING
        result, self.result = self.result, None
        return result

    def terminate(self, new_status):
        self.pending = False

    def execute(self):
        self.pending = False
        self.result = self.operation()


def build_tree(a, state):
    """Bind domain operations; SKILL.xml owns tree structure and ordering."""
    name, world = a["device"], a["world"]

    def prepare():
        prof = profile(name)
        if prof["type"] != "joint" or not prof["loaded"]:
            raise ValueError("move_and_verify requires a loaded joint device")
        clock = profile(world)
        if clock["type"] != "world" or not clock["loaded"]:
            raise ValueError("move_and_verify requires a loaded world device")
        joints = prof["resolved_model"]["joints"]
        goal = joint_target(a["joints"], joints,
                            check_limits=prof["intrinsics"]["control"].get("limit_handling") != "native")
        spec = {}
        for key in ("joint_tolerance", "quiet_velocity"):
            values = a[key] if isinstance(a[key], list) else [a[key]] * len(joints)
            spec[key] = vector(values, len(joints), key)
        for key, default in (("stable_s", .1), ("wait_s", .05), ("timeout_s", 10.0), ("speedFraction", 1.0)):
            state[key] = a.get(key, default)
        if state["stable_s"] > state["timeout_s"]:
            raise ValueError("stable_s must be <= timeout_s")
        spec.update(stable_s=state["stable_s"], estimate_velocity=not prof["intrinsics"]["feedback"]["velocities"])
        state.update(goal=goal, arrival=Arrival(joints, goal, spec), samples=0)
        state["started_s"] = state["time_s"] = number(device(world)["data"]["time_s"], "world.time_s")
        return Status.SUCCESS

    def move():
        state["motion"] = call("servo", device=name, joints=state["goal"], speedFraction=state["speedFraction"])
        return Status.SUCCESS

    def verify():
        before = number(device(world)["data"]["time_s"], "world.time_s")
        if before < state["time_s"]:
            raise ValueError("world clock moved backwards")
        remaining = state["timeout_s"] - (before - state["started_s"])
        if remaining > 0:
            device(world, "wait", duration_s=min(state["wait_s"], remaining))
        now = number(device(world)["data"]["time_s"], "world.time_s")
        if now < before:
            raise ValueError("world clock moved backwards")
        state["time_s"] = now
        measured = read(name)
        if measured["faults"]:
            raise RPCError(f"{name}: device fault", code="device_fault", details={"faults": measured["faults"]})
        state["measured"] = measured
        state["samples"] += 1
        elapsed = now - state["started_s"]
        if elapsed <= state["timeout_s"] + 1e-9 and state["arrival"].sample(measured, time_s=now):
            return Status.SUCCESS
        if elapsed >= state["timeout_s"] - 1e-9:
            state["reason"] = "arrival_timeout"
            return Status.FAILURE
        return Status.RUNNING

    def stop():
        stop_owned()
        return Status.SUCCESS

    return parse_behaviour_tree_xml(str(Path(__file__).with_name("SKILL.xml")), node_registry={
        "Validate": partial(Action, operation=prepare),
        "Move": partial(Action, operation=move),
        "Verify": partial(Action, operation=verify),
        "Stop": partial(Action, operation=stop),
    })


def control(a):
    state, trace = {}, deque(maxlen=64)
    root = build_tree(a, state)
    previous = {}

    def snapshot():
        for node in root.iterate():
            if previous.get(node.id) != node.status:
                trace.append({"node": node.name, "status": node.status.value})
                previous[node.id] = node.status

    with stop_on_error():
        try:
            while True:
                root.tick_once()
                snapshot()
                if root.status != Status.RUNNING:
                    break
                pending = [node for node in root.iterate() if isinstance(node, Action) and node.pending]
                # Execute I/O serially. A completed RUNNING
                # leaf queues its next observation on the following tick.
                if len(pending) > 1:
                    raise ValueError("parallel I/O is not supported by this skill")
                for node in pending:
                    node.execute()
            if root.status != Status.SUCCESS:
                raise RPCError("joint arrival was not verified before the world-time deadline",
                               code=state["reason"], details={"trace": list(trace), "samples": state["samples"]})
            return {"status": "SUCCESS", **state["motion"],
                    "measured": state["measured"], "samples": state["samples"],
                    "elapsed_s": state["time_s"] - state["started_s"], "trace": list(trace),
                    "tree": py_trees.display.unicode_tree(root, show_status=True)}
        finally:
            root.stop(Status.INVALID)


if __name__ == "__main__":
    finish(control(args()))
