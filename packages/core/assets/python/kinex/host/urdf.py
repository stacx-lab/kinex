"""URDF commands for the TypeScript runtime, reading stdin and printing JSON:
`tree BASE_LINK` resolves the tree below BASE_LINK from URDF XML, and `pose` computes
a link pose in its tree's base from {tree, link, positions}."""
import json
import sys

from kinex.lib.geometry import flat
from kinex.lib.kinematics import Chain
from kinex.lib.urdf import positions, read_tree


def pose(request):
    chain = Chain(request["tree"], request["link"])
    values = positions(request["tree"], request["positions"])
    missing = [joint["name"] for joint in chain.joints if joint["name"] not in values]
    if missing:
        sys.exit(f"joint state lacks {', '.join(missing)}")
    return flat(chain.forward(values)[0])


if __name__ == "__main__":
    result = read_tree(None, sys.argv[2], sys.stdin.read()) if sys.argv[1] == "tree" else pose(json.load(sys.stdin))
    print(json.dumps(result, allow_nan=False))
