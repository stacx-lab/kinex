#!/usr/bin/env python3
"""Resolve one device's selected URDF chain, or its whole tree below base_link."""
import argparse
import json
import sys
from kinex.urdf import read_chain, read_tree

parser = argparse.ArgumentParser()
parser.add_argument("--urdf", required=True)
parser.add_argument("--base-link", required=True)
parser.add_argument("--tip-link")
parser.add_argument("--stdin", action="store_true")
args = parser.parse_args()
xml = sys.stdin.read() if args.stdin else None
model = read_tree(args.urdf, args.base_link, xml) if args.tip_link is None else read_chain(args.urdf, args.base_link, args.tip_link, xml)
print(json.dumps(model, allow_nan=False))
