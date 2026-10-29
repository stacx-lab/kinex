"""Policy execution: one inference turned into validated device commands."""

import math

from kinex import profile
from kinex.lib.geometry import compose_rt, number, vector, xyzq_to_rt
from kinex.lib.joints import JointModel, command as joint_command, measured_positions

END_EFFECTORS = {"gripper", "suction"}


async def run_policy(io, model, observation, command, task=None, world="world", action_hz=10,
                     max_actions=None, inference_args=None):
    """Infer once and submit the valid action prefix to every commanded device.

    model serves a Json "infer" operation taking obs (and task) and returning
    actions or action. command lists {"device", "space", "frame", "target_frame"}
    entries in flat-vector split order; named action maps use device names.
    space "device" takes absolute joint values in URDF order, or end-effector
    values in [-1, 1] that release at -1 and grip at +1; "pose" (xyz + xyzw) and
    "pose_delta" (xyz + axis-angle) solve URDF IK for joint devices with a
    tip_link, frozen at the observation stamp. max_actions caps the horizon and
    action_hz paces actions on the world clock. Joint trajectories submit
    asynchronously; end-effector targets are paced by world waits before
    returning. Returns actions_submitted, duration_s and ik_failure
    (device, action_index, error) or None.

    Example: await helpers.run_policy(io, "policy", obs, [{"device": "arm"}, {"device": "gripper"}])
    """
    import asyncio
    from kinex.communication import duration
    from kinex.helpers.frames import IDENTITY, transform_pose
    from kinex.lib.geometry import invert_rt, rt_to_pose
    plans = [_commanded(entry) for entry in command]
    if len({entry["name"] for entry in plans}) != len(plans):
        raise ValueError("command must name each device once")
    wait = f"{world}.wait"
    if any(entry["model"] is None for entry in plans) and wait not in io.catalog:
        raise ValueError("end-effector policy sequences require a loaded world wait operation")
    options = inference_args or {}
    if set(options) & {"obs", "task"}:
        raise ValueError("inference_args cannot override obs or task")
    data = await io.request(f"{model}.infer", **options, obs=observation, **({"task": task} if task else {}))
    actions = data.get("actions", [data["action"]] if "action" in data else None)
    if not actions:
        raise ValueError("infer must return nonempty actions")
    actions = actions[:max_actions or len(actions)]
    split = [_share(action, plans) for action in actions]
    count, failure, sequences = len(split), None, {}
    for entry in plans:
        name, spec = entry["name"], entry["spec"]
        samples = [item[name] for item in split[:count]]
        if spec.get("space", "device") != "device":
            stream = io.subscribe(f"{name}.joint_state", depth=1)
            try:
                state = await stream.next(timeout_s=10)
            finally:
                stream.close()
            joints = entry["model"]
            seed = measured_positions(state, joints.joints)
            base = f"{name}/base"
            ik_frame = f"{name}/{joints.tip}"
            target_frame = spec.get("target_frame", ik_frame)
            reference = spec.get("frame", base)
            # target_frame is an attached tool frame. Freeze its offset at the
            # observation stamp while resolving the policy's Cartesian chunk;
            # URDF FK of the measured joints places the tip.
            offset = await transform_pose(io, IDENTITY, ik_frame, target_frame, state.header.stamp)
            tool = rt_to_pose(compose_rt(xyzq_to_rt(joints.fk(seed)), invert_rt(xyzq_to_rt(offset))))
            current = await transform_pose(io, tool["translation"] + tool["rotation"], base, reference, state.header.stamp)
            converted = []
            for sample in samples:
                if spec["space"] == "pose_delta":
                    value = rt_to_pose(_delta_pose(xyzq_to_rt(current), sample))
                    current = value["translation"] + value["rotation"]
                else:
                    current = sample
                ik = rt_to_pose(compose_rt(xyzq_to_rt(current), xyzq_to_rt(offset)))
                goal = await transform_pose(io, ik["translation"] + ik["rotation"], reference, base, state.header.stamp)
                try:
                    seed = joints.ik(goal, seed)
                except ValueError as error:
                    failure = {"device": name, "action_index": len(converted), "error": str(error)}
                    break
                converted.append(seed)
            samples = converted
            count = min(count, len(samples))
        sequences[name] = samples
    if count == 0:
        return {"actions_submitted": 0, "duration_s": 0, "ik_failure": failure}
    seconds = count / number(action_hz, "action_hz")
    prepared, scalars = [], []
    for entry in plans:
        name, prof = entry["name"], entry["profile"]
        samples = sequences[name][:count]
        if entry["model"]:
            joint_command(prof, samples, entry["model"].joints)
            fields = {"joint_names": entry["model"].names,
                      "points": [{"positions": value, "time_from_start": duration((index + 1) * seconds / count)}
                                 for index, value in enumerate(samples)]}
            operation = f"{name}.joint_target"
        else:
            target = _grip if prof["type"] == "gripper" else _vacuum
            targets = [target(prof, value[0]) for value in samples]
            fields, operation = {"data": targets[0]}, f"{name}.target"
            scalars.append((operation, targets))
        prepared.append((operation, fields))

    await asyncio.gather(*(io.publish(operation, fields) for operation, fields in prepared))
    # End-effector targets persist. Timing belongs to this workflow and the world,
    # never a device-side duration or a background worker.
    if scalars:
        for index in range(count):
            if index:
                await asyncio.gather(*(io.publish(operation, {"data": values[index]})
                                       for operation, values in scalars))
            await io.request(wait, duration_s=seconds / count)
    return {"actions_submitted": count, "duration_s": seconds, "ik_failure": failure}


def _commanded(entry):
    """One commanded device: its profile, joint model and share of an action vector."""
    name = entry["device"]
    prof = profile(name)
    kind = prof.get("type")
    if kind not in END_EFFECTORS | {"joint"}:
        raise ValueError(f"{name} is {kind}; run_policy commands joint, gripper or suction devices")
    model = None if kind in END_EFFECTORS else JointModel(prof)
    # A gripper or suction tool takes one command value whatever it reports back.
    width = _cartesian_width(entry, prof)
    return {"name": name, "profile": prof, "model": model, "spec": entry,
            "width": width or (1 if kind in END_EFFECTORS else len(model.joints))}


def _share(action, plan):
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


def _cartesian_width(entry, prof):
    space = entry.get("space", "device")
    if space not in {"device", "pose", "pose_delta"}:
        raise ValueError(f"unknown policy space: {space}")
    if space == "device":
        if "frame" in entry or "target_frame" in entry:
            raise ValueError("frame and target_frame require Cartesian policy actions")
        return None
    if prof["type"] != "joint" or not prof["model"]["tip_link"]:
        raise ValueError("Cartesian policy actions require a joint device with a model tip_link")
    return 7 if space == "pose" else 6


def _delta_pose(current, action):
    """Translation and rotation increments use fixed reference-frame axes."""
    action = vector(action, 6, "pose_delta")
    angle = math.hypot(*action[3:])
    scale = math.sin(angle / 2) / angle if angle else 0.5
    rotation = xyzq_to_rt([0, 0, 0, *[v * scale for v in action[3:]], math.cos(angle / 2)])
    return compose_rt(rotation, (current[0], [0, 0, 0]))[0], [a + b for a, b in zip(current[1], action[:3])]


def _action(value):
    value = number(value, "action")
    if not -1 <= value <= 1:
        raise ValueError("end-effector actions must be in [-1, 1]: -1 releases, +1 grips")
    return value


def _grip(profile, value):
    """Interpolate the grip joint from open to closed."""
    grip = profile["grip"]
    if not isinstance(grip, dict):
        raise ValueError("the gripper has no declared grip joint")
    return grip["open"] + (_action(value) + 1) / 2 * (grip["closed"] - grip["open"])


def _vacuum(profile, value):
    """A vacuum level from release (0) to full vacuum (1); binary devices switch on above 0."""
    value = _action(value)
    if profile["vacuum"] == "binary":
        return 1.0 if value > 0 else 0.0
    if profile["vacuum"] != "proportional":
        raise ValueError("the suction device declares no vacuum control")
    return (value + 1) / 2
