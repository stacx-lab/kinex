"""Publish the device's URDF links on TF from measured joint states."""
from pathlib import Path

from kinex.ros_links import LinkPublisher


def create(profile, context):
    return LinkPublisher(profile, context, Path(__file__).parent)
