#!/usr/bin/env python3
"""Execute one inference worth of policy actions."""

from math import isclose

from kinex import args, device, finish, profile
from kinex.control import execute, read, stop_all, stop_on_error
from kinex.joint_control import command as joint_command, joint_model
from kinex.scalar_control import command as scalar_command
from kinex.validation import vector

SCALAR = {"gripper", "suction"}
JOINTED = {"joint", "dexterous_hand"}


def commanded(entry):
    """One commanded device: its profile, joint model and share of an action vector."""
    name = entry["device"]
    prof = profile(name)
    kind = prof.get("type")
    if kind not in SCALAR | JOINTED:
        raise ValueError(f"{name} is {kind}; run_policy commands joint, dexterous_hand, gripper or suction devices")
    model = None if kind in SCALAR else joint_model(prof)
    # A gripper or suction tool takes one command value whatever it reports back.
    return {"name": name, "profile": prof, "model": model,
            "width": 1 if kind in SCALAR else len(model["joints"])}


def share(action, plan):
    """One action, split across the commanded devices in order."""
    if isinstance(action, dict):
        missing = [e["name"] for e in plan if e["name"] not in action]
        if missing:
            raise ValueError(f"action names no value for {', '.join(missing)}")
        return {e["name"]: vector(action[e["name"]], e["width"], f"action for {e['name']}") for e in plan}
    vector(action, sum(e["width"] for e in plan), "policy action")
    shares, cursor = {}, 0
    for entry in plan:
        shares[entry["name"]] = list(action[cursor:cursor + entry["width"]])
        cursor += entry["width"]
    return shares


def commands(shares, plan, budget):
    built = {}
    for entry in plan:
        payload = {"target": shares[entry["name"]], "for_s": budget}
        if entry["model"] is None:
            scalar_command(entry["profile"], payload)
        else:
            joint_command(entry["profile"], payload, entry["model"])
        built[entry["name"]] = payload
    return built


def control(a):
    model = a["model"]
    policy = profile(model)
    operations = [o["name"] for o in policy.get("intrinsics", {}).get("operations", [])]
    if policy.get("type") != "model" or "infer" not in operations:
        raise ValueError("model must be a model device declaring infer")
    plan = [commanded(entry) for entry in a["command"]]
    if len({e["name"] for e in plan}) != len(plan):
        raise ValueError("command must name each device once")
    lead, names = plan[0], [e["name"] for e in plan]

    inference = device(model, "infer", obs=a["observation"],
                       **({"task": a["task"]} if a.get("task") else {})).get("data") or {}
    actions = inference.get("actions")
    if actions is None:
        single = inference.get("action")
        if single is None:
            raise ValueError("infer must return action or actions")
        actions = [single]
    if not isinstance(actions, list) or not actions:
        raise ValueError("infer actions must be a non-empty list")
    if a.get("max_actions") is not None:
        actions = actions[:a["max_actions"]]

    hold, budget = 1.0 / a.get("action_hz", 10), a.get("timeout_s", 30)
    elapsed, executed, reason = 0.0, 0, None
    faulted = []
    with stop_on_error(names):
        for action in actions:
            command = commands(share(action, plan), plan, min(hold, budget - elapsed))
            held = 0.0
            # Hold each action for its full period: a device that advances inside
            # the write needs several, one that runs the command out needs one.
            while reason is None:
                remaining = min(hold - held, budget - elapsed)
                outcome = execute(lead["name"], command, remaining)
                spent = outcome["elapsed_s"]
                held, elapsed = held + spent, elapsed + spent
                faulted = outcome["faulted_devices"]
                if faulted:
                    reason = "fault"
                elif elapsed >= budget or isclose(elapsed, budget):
                    reason = "timeout"
                elif spent <= 0:
                    reason = "stalled"
                elif held >= hold or isclose(held, hold):
                    break
            executed += 1
            if reason is not None:
                break
    reason = reason or ("done" if inference.get("done") else "chunk_complete")
    continuing = reason == "timeout" and a.get("on_timeout", "stop") == "continue"
    if not continuing:
        stop_all(names)
    with stop_on_error(names if continuing else []):
        final = read(lead["name"])
    if final["faults"]:
        reason = "fault"
        faulted = list(dict.fromkeys([*faulted, lead["name"]]))
        if continuing:
            stop_all(names)
    return {"reached": reason == "done", "terminated_by": reason,
            "actions_executed": executed, "actions_offered": len(actions),
            "elapsed_s": elapsed, "state": final, "faulted_devices": faulted}


if __name__ == "__main__":
    finish(control(args()))
