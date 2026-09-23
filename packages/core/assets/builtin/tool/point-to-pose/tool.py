#!/usr/bin/env python3
"""Convert a located point into pose arguments for a controller."""

from kinex import args, device, finish
from kinex.control import read
from kinex.frames import pose as frame_pose
from kinex.geometry import apply_rt, pose_to_rt
from kinex.motion import pose as unit_pose, vector


def process(a):
    observation, name = a["observation"], a["device"]
    point = observation["point"]
    if point is None:
        return {"args": None}
    point = vector(point, 3, "located point")
    frame = a.get("frame") or observation.get("frame")
    if not frame:
        raise ValueError("the observation names no frame for its point; supply frame")
    if frame != name:
        point = apply_rt(pose_to_rt(frame_pose(frame, name)), point)
    offset = vector(a.get("offset_m", [0, 0, 0]), 3, "offset_m")
    rotation = a.get("orientation")
    if rotation is None:
        state = read(name)
        rotation = unit_pose((device(name, "fk", joints=state["positions"]).get("data") or {})["pose"])[3:]
    pose = unit_pose([p + o for p, o in zip(point, offset)] + list(rotation))
    return {"args": {"pose": pose, "frame": name}}


if __name__ == "__main__":
    finish(process(args()))
