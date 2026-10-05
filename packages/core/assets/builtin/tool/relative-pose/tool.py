#!/usr/bin/env python3
"""Express one frame-attached pose in another."""

from kinex import args, finish, frames
from kinex.geometry import compose_rt, invert_rt, pose_to_rt, rt_to_pose, xyzq_to_rt
from kinex.motion import pose


def relative(a):
    child, parent = a["child"], a["parent"]
    identity = [0, 0, 0, 0, 0, 0, 1]
    local_child = xyzq_to_rt(pose(child.get("pose", identity), "child.pose"))
    local_parent = xyzq_to_rt(pose(parent.get("pose", identity), "parent.pose"))
    relation = frames.pose(child["frame"], parent["frame"], estimates=a.get("estimates"))
    result = rt_to_pose(compose_rt(invert_rt(local_parent), compose_rt(pose_to_rt(relation), local_child)))
    return {"pose": result["translation"] + result["rotation"],
            "path": relation["path"], "estimated_links": relation["estimated_links"]}


if __name__ == "__main__":
    finish(relative(args()))
