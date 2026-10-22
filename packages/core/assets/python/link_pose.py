#!/usr/bin/env python3
"""Pose of one URDF link in its tree's base at measured joint positions: {tree, link, positions} on stdin."""
import json
import sys
from kinex.kinematics import Chain
from kinex.motion import flat
from kinex.urdf import positions

request = json.load(sys.stdin)
chain = Chain(request["tree"], request["link"])
values = positions(request["tree"], request["positions"])
missing = [joint["name"] for joint in chain.joints if joint["name"] not in values]
if missing:
    sys.exit(f"joint state lacks {', '.join(missing)}")
print(json.dumps(flat(chain.forward(values)[0]), allow_nan=False))
