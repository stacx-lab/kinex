"""Submit a typed joint trajectory and optionally wait on world time."""
from kinex import profile
from kinex.joint_control import home_start_tolerance, measured_positions, project_seed
from kinex.motion import joint_target
from kinex.trajectory import trajectory


async def main(a, io):
    from kinex.ros_tools import duration, pose_fields, transform_pose
    unknown = set(a) - {"device", "joints", "pose", "frame", "world", "block",
                        "speedFraction", "max_velocity", "max_acceleration"}
    if unknown:
        raise ValueError(f"unsupported servo arguments: {sorted(unknown)}")
    if ("joints" in a) == ("pose" in a) or ("joints" in a and "frame" in a):
        raise ValueError("provide joints or pose, with frame only for pose goals")
    if not isinstance(a.get("block", True), bool):
        raise ValueError("block must be boolean")
    wait = f"{a.get('world', 'world')}.wait"
    if a.get("block", True) and wait not in io.catalog:
        raise ValueError("blocking servo requires a loaded world wait operation")
    name = a["device"]
    prof = profile(name)
    if prof.get("type") not in {"joint", "dexterous_hand"}:
        raise ValueError("servo requires a joint or dexterous_hand device")
    if a.get("joints") is None and f"{name}.ik" not in io.catalog:
        raise ValueError("pose goals require declared IK")
    model = prof["resolved_model"]
    stream = io.subscribe(f"{name}.joint_state", depth=1)
    try:
        state = await stream.next(timeout_s=10)
    finally:
        stream.close()
    order = [joint["name"] for joint in model["joints"]]
    start = measured_positions(state, model["joints"])
    goal = a.get("joints")
    if goal is None:
        target = a["pose"]
        if a.get("frame"):
            target = await transform_pose(io, target, a["frame"], name, state.header.stamp)
        result = await io.request(f"{name}.ik", target=pose_fields(target),
                                  seed=project_seed(start, model["joints"]))
        goal = list(result.joints)
    check = prof["intrinsics"]["control"].get("limit_handling") != "native"
    goal = joint_target(goal, model["joints"], check_limits=check)
    plan = trajectory(model["joints"], start, goal, .01,
                      a.get("speedFraction", 1.), a.get("max_velocity"), a.get("max_acceleration"),
                      check_limits=check, start_tolerance=home_start_tolerance(prof, model["joints"], goal))
    points = [{"positions": point, "time_from_start": duration((index + 1) * plan.duration_s / len(plan.actions))}
              for index, point in enumerate(plan.actions)]
    identifier = await io.publish(f"{name}.joint_target", {"trajectory": {"joint_names": order, "points": points}})
    if identifier:
        await io.accepted(f"{name}.joint_target", identifier)
    if a.get("block", True):
        await io.request(wait, duration_s=plan.duration_s)
    return {"device": name, "execution_id": identifier, "joints": goal,
            "duration_s": plan.duration_s, "actions_submitted": len(points)}
