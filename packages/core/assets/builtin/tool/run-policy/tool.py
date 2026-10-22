#!/usr/bin/env python3
"""Execute one inference worth of policy actions."""

from kinex import profile
from kinex.joint_control import command as joint_command, joint_model
from kinex.scalar_control import command as scalar_command
from kinex.validation import vector
from kinex.policy import cartesian_width

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


async def main(a, io):
    import asyncio
    from kinex.ros_tools import duration, pose_fields, transform_pose
    from kinex.geometry import compose_rt, xyzq_to_rt, rt_to_pose
    from kinex.joint_control import measured_positions, project_seed
    from kinex.motion import joint_target
    from kinex.policy import delta_pose
    plans = [commanded(entry) for entry in a["command"]]
    if len({entry["name"] for entry in plans}) != len(plans):
        raise ValueError("command must name each device once")
    options = a.get("inference_args", {})
    if set(options) & {"obs", "task"}:
        raise ValueError("inference_args cannot override obs or task")
    data = await io.request(f"{a['model']}.infer", **options, obs=a["observation"],
                            **({"task": a["task"]} if a.get("task") else {}))
    actions = data.get("actions", [data["action"]] if "action" in data else None)
    if not actions:
        raise ValueError("infer must return nonempty actions")
    actions = actions[:a.get("max_actions", len(actions))]
    split = [share(action, plans) for action in actions]
    count, failure, sequences = len(split), None, {}
    for entry in plans:
        name, prof, spec = entry["name"], entry["profile"], entry["spec"]
        samples = [item[name] for item in split[:count]]
        if spec.get("space", "device") != "device":
            stream = io.subscribe(f"{name}.joint_state", depth=1)
            try:
                state = await stream.next(timeout_s=10)
            finally:
                stream.close()
            seed = project_seed(measured_positions(state, entry["model"]["joints"]), entry["model"]["joints"])
            base = f"{name}/base"
            ik_frame = f"{name}/{prof['kinematics']['frame']}"
            target_frame = spec.get("target_frame", ik_frame)
            reference = spec.get("frame", base)
            identity = [0, 0, 0, 0, 0, 0, 1]
            # target_frame is an attached tool frame. Freeze its offset at the
            # observation stamp while resolving the policy's Cartesian chunk.
            offset = await transform_pose(io, identity, ik_frame, target_frame, state.header.stamp)
            current = await transform_pose(io, identity, target_frame, reference, state.header.stamp)
            converted = []
            for sample in samples:
                if spec["space"] == "pose_delta":
                    current_rt = delta_pose(xyzq_to_rt(current), sample)
                    value = rt_to_pose(current_rt)
                    current = value["translation"] + value["rotation"]
                else:
                    current = sample
                ik = rt_to_pose(compose_rt(xyzq_to_rt(current), xyzq_to_rt(offset)))
                goal = await transform_pose(io, ik["translation"] + ik["rotation"], reference, base, state.header.stamp)
                try:
                    solved = await io.request(f"{name}.ik", target=pose_fields(goal), seed=seed)
                    seed = joint_target(list(solved.joints), entry["model"]["joints"])
                    converted.append(seed)
                except (RuntimeError, ValueError) as error:
                    if getattr(error, "code", None) == "stop_failed":
                        raise
                    failure = {"device": name, "action_index": len(converted), "error": str(error)}
                    break
            samples = converted
            count = min(count, len(samples))
        sequences[name] = samples
    if count == 0:
        return {"actions_submitted": 0, "duration_s": 0, "execution_ids": {}, "ik_failure": failure}
    seconds = count / a.get("action_hz", 10)
    prepared, scalars = [], []
    wait = f"{a.get('world', 'world')}.wait"
    if any(entry["model"] is None for entry in plans) and wait not in io.catalog:
        raise ValueError("scalar policy sequences require a loaded world wait operation")
    for entry in plans:
        name, prof = entry["name"], entry["profile"]
        samples = sequences[name][:count]
        command = {"actions": samples if entry["model"] else [value[0] for value in samples], "duration_s": seconds}
        if entry["model"]:
            joint_command(prof, command, entry["model"])
            fields = {"trajectory": {"joint_names": [joint["name"] for joint in entry["model"]["joints"]],
                      "points": [{"positions": value, "time_from_start": duration((index + 1) * seconds / count)}
                                 for index, value in enumerate(samples)]}}
            operation = f"{name}.joint_target"
        else:
            scalar_command(prof, command)
            fields, operation = {"target": command["actions"][0]}, f"{name}.target"
            scalars.append((name, operation, command["actions"]))
        prepared.append((name, operation, fields))
    async def submit(name, operation, fields):
        identifier = await io.publish(operation, fields)
        if identifier:
            await io.accepted(operation, identifier)
        return name, identifier
    results = await asyncio.gather(*(submit(*entry) for entry in prepared))
    # Scalar targets persist. Timing belongs to this workflow and the world,
    # never a device-side duration or an unowned background worker.
    if scalars:
        for index in range(count):
            if index:
                results.extend(await asyncio.gather(*(submit(name, operation, {"target": values[index]})
                                                     for name, operation, values in scalars)))
            await io.request(wait, duration_s=seconds / count)
    return {"actions_submitted": count, "duration_s": seconds, "execution_ids": dict(results), "ik_failure": failure}
