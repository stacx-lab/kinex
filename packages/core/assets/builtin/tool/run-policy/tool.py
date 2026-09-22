#!/usr/bin/env python3
"""Execute one inference worth of policy actions; track closes the loop."""

from kinex import args, device, finish, profile
from kinex.control import execute, read
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


def commands(shares, plan):
    built = {}
    for entry in plan:
        payload = {"target": shares[entry["name"]]}
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
    elapsed, executed, reason, state = 0.0, 0, None, None
    try:
        for action in actions:
            payloads, held = commands(share(action, plan), plan), 0.0
            # Hold each action for its full period: a device that advances inside
            # the write needs several, one that runs the command out needs one.
            while held < hold - 1e-9 and elapsed < budget and reason is None:
                outcome = execute(lead["name"], payloads, min(hold - held, budget - elapsed))
                spent = outcome["elapsed_s"]
                held, elapsed, state = held + spent, elapsed + spent, outcome["state"]
                if state["faults"]:
                    reason = "fault"
                elif spent <= 0:
                    reason = "stalled"
            executed += 1
            if reason is None and elapsed >= budget:
                reason = "timeout"
            if reason is not None:
                break
        reason = reason or ("done" if inference.get("done") else "chunk_complete")
    except BaseException:
        for name in names:
            try:
                device(name, "stop")
            except Exception:
                pass
        raise
    if reason == "fault" or a.get("on_timeout", "stop") != "continue":
        for name in names:
            device(name, "stop")
    return {"reached": reason == "done", "terminated_by": reason,
            "actions_executed": executed, "actions_offered": len(actions),
            "elapsed_s": round(elapsed, 4), "state": read(lead["name"])}


if __name__ == "__main__":
    finish(control(args()))
