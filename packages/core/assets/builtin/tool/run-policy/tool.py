#!/usr/bin/env python3
"""Execute one inference worth of policy actions."""

from kinex import args, device, finish, profile, devices
from kinex.control import stop_on_error
from kinex.joint_control import command as joint_command, joint_model
from kinex.scalar_control import command as scalar_command
from kinex.validation import vector
from kinex.policy import cartesian_width, joint_sequence

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
    width = cartesian_width(entry, prof)
    return {"name": name, "profile": prof, "model": model, "spec": entry,
            "width": width or (1 if kind in SCALAR else len(model["joints"]))}


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
    names = [e["name"] for e in plan]

    options = a.get("inference_args", {})
    if set(options) & {"obs", "task"}:
        raise ValueError("inference_args cannot override obs or task")
    inference = device(model, "infer", **options, obs=a["observation"],
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

    split = [share(action, plan) for action in actions]
    sequences, count, ik_failure = {}, len(split), None
    for entry in plan:
        samples = [action[entry["name"]] for action in split[:count]]
        if entry["model"] is not None:
            sequence, failure = joint_sequence(entry, samples)
            if failure is not None:
                count, ik_failure = len(sequence), failure
                if count == 0:
                    return {"actions_submitted": 0, "duration_s": 0,
                            "writes": {}, "ik_failure": ik_failure}
        else:
            sequence = [action[0] for action in samples]
        sequences[entry["name"]] = sequence

    duration = count / a.get("action_hz", 10)
    # Validate the shared prefix before submitting any device.
    for entry in plan:
        name = entry["name"]
        sequences[name] = sequences[name][:count]
        command = {"actions": sequences[name], "duration_s": duration}
        if entry["model"] is not None:
            joint_command(entry["profile"], command, entry["model"])
        else:
            scalar_command(entry["profile"], command)
    with stop_on_error(names):
        results = devices([{"device": name, "action": "write", "args": {
            "actions": sequences[name], "duration_s": duration}} for name in names])
        for result in results:
            if not result.get("ok"):
                raise RuntimeError(result.get("error", "policy write failed"))
            if (result.get("data") or {}).get("state", {}).get("faults"):
                raise RuntimeError("policy write reported device faults")
        outcomes = {name: result["data"] for name, result in zip(names, results)}
        return {"actions_submitted": count, "duration_s": duration,
                "writes": outcomes, "ik_failure": ik_failure}


if __name__ == "__main__":
    finish(control(args()))
