#!/usr/bin/env python3
"""Resolve the URDF tree below base_link from URDF XML on stdin."""
import json
import sys
from kinex.urdf import read_tree

print(json.dumps(read_tree(None, sys.argv[1], sys.stdin.read()), allow_nan=False))
