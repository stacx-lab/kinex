#!/usr/bin/env python3
"""Provision the demo-arm bundle directory; setup.sh passes the destination and both library roots."""
import sys
from pathlib import Path

from kinex_ros.bundle import provision

HERE = Path(__file__).resolve().parent


def urdf(bundle, facts, state):
    """Bundle-specific step: render a stand-in model.urdf before the profile is written."""
    path = bundle.directory / "model.urdf"
    path.write_text(f'<robot name="{facts["name"]}"></robot>\n')
    return f"wrote {path.name}"


if __name__ == "__main__":
    sys.exit(provision(HERE, sys.argv[1:], steps={"urdf": urdf}))
