"""Named hand postures to bounded joint commands; no claim of object acquisition."""

from kinex.joint_control import command, joint_model
from kinex.validation import number


def target(profile, postures, name, closure=1.0):
    control = profile["control"]
    if profile.get("type") != "dexterous_hand" or control["mode"] != "position":
        raise ValueError("A joint-controlled dexterous hand is required")
    amount = number(closure)
    if not 0 <= amount <= 1:
        raise ValueError("closure must be in [0, 1]")
    joints = [joint["name"] for joint in joint_model(profile)["joints"]]
    opened, closed = postures["open"], postures[name]
    if set(opened) != set(joints) or set(closed) != set(joints):
        raise ValueError("Postures must name every hand joint exactly once")
    for posture in (opened, closed):
        command(profile, {"target": [number(posture[joint]) for joint in joints]})
    values = [number(opened[j]) * (1 - amount) + number(closed[j]) * amount for j in joints]
    command(profile, {"target": values})
    return values
