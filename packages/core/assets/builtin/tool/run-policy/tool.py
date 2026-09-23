#!/usr/bin/env python3
"""Execute one inference worth of policy actions."""

from kinex import args, device, finish, profile, devices
from kinex.control import stop_all, stop_on_error
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

    frequency, budget = a.get("action_hz", 10), a.get("timeout_s", 30)
    split = [share(action, plan) for action in actions]
    sequences = {entry["name"]: [action[entry["name"]] for action in split] for entry in plan}
    # Validate the entire chunk before admitting its first action.
    for entry in plan:
        if entry["model"] is not None:
            joint_command(entry["profile"], {"actions": sequences[entry["name"]], "freq_hz": frequency}, entry["model"])
        else:
            for target in sequences[entry["name"]]:
                scalar_command(entry["profile"], {"target": target, "for_s": 1 / frequency})
    with stop_on_error(names):
        results = devices([{"device": name, "action": "write", "args": {
            "actions": sequences[name], "freq_hz": frequency, "for_s": budget}} for name in names])
        for result in results:
            if not result.get("ok"):
                raise RuntimeError(result.get("error", "policy write failed"))
        outcomes = {name: result["data"] for name, result in zip(names, results)}
        states = {name: outcome["state"] for name, outcome in outcomes.items()}
        completed = min(outcome["completed_actions"] for outcome in outcomes.values())
        reason = "timeout" if completed < len(actions) else "done" if inference.get("done") else "chunk_complete"
        faulted = [name for name, state in states.items() if state["faults"]]
        if faulted:
            raise RuntimeError(f"fault: {', '.join(faulted)}")
        stalled = [name for name, outcome in outcomes.items()
                   if outcome["elapsed_s"] <= 0 and outcome.get("terminated_by") != "timeout"]
        if stalled:
            raise RuntimeError(f"stalled: {', '.join(stalled)}")
        if reason == "timeout":
            stop_all(names)
        return {"reached": reason == "done", "terminated_by": reason,
                "actions_executed": completed, "actions_offered": len(actions),
                "elapsed_s": max(outcome["elapsed_s"] for outcome in outcomes.values()),
                "state": states[lead["name"]], "states": states}


if __name__ == "__main__":
    finish(control(args()))
