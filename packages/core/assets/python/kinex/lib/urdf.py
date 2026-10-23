"""Read device URDF trees; no SDK, simulator or numerical dependencies."""

import math
from pathlib import Path
from xml.etree import ElementTree

from kinex.lib.geometry import compose_rt, quat_to_mat, vector, xyzq_to_rt

MOVABLE = {"revolute", "continuous", "prismatic"}


def rpy_quaternion(roll, pitch, yaw):
    cr, sr = math.cos(roll/2), math.sin(roll/2)
    cp, sp = math.cos(pitch/2), math.sin(pitch/2)
    cy, sy = math.cos(yaw/2), math.sin(yaw/2)
    return [sr*cp*cy-cr*sp*sy, cr*sp*cy+sr*cp*sy, cr*cp*sy-sr*sp*cy, cr*cp*cy+sr*sp*sy]


def numbers(element, attribute, default):
    return vector([float(v) for v in (element.get(attribute, default) if element is not None else default).split()], 3, attribute)


def parse(path, xml=None):
    """Links and each child link's joint, validated as a forest of unique names."""
    root = ElementTree.fromstring(xml) if xml is not None else ElementTree.parse(Path(path)).getroot()
    if root.tag != "robot":
        raise ValueError("Expected a URDF robot")
    links = [link.attrib["name"] for link in root.findall("link")]
    if len(links) != len(set(links)):
        raise ValueError("URDF link names must be unique")
    parents, names = {}, set()
    for joint in root.findall("joint"):
        name = joint.attrib["name"]
        parent, child = joint.find("parent"), joint.find("child")
        if parent is None or child is None or parent.attrib["link"] not in links or child.attrib["link"] not in links:
            raise ValueError(f"Invalid parent/child for URDF joint {name}")
        if name in names or child.attrib["link"] in parents:
            raise ValueError("URDF joint names and child links must be unique")
        names.add(name)
        parents[child.attrib["link"]] = joint
    return links, parents


def origin(joint):
    element = joint.find("origin")
    return numbers(element, "xyz", "0 0 0") + rpy_quaternion(*numbers(element, "rpy", "0 0 0"))


def motion(joint):
    """Axis, position limits and rate limits of a movable joint."""
    name, kind = joint.attrib["name"], joint.attrib["type"]
    limit = joint.find("limit")
    bounds = None
    if kind != "continuous":
        if limit is None or "lower" not in limit.attrib or "upper" not in limit.attrib:
            raise ValueError(f"Missing position limits for {name}")
        bounds = {"min": float(limit.attrib["lower"]), "max": float(limit.attrib["upper"])}
        if not math.isfinite(bounds["min"]) or not math.isfinite(bounds["max"]) or bounds["min"] >= bounds["max"]:
            raise ValueError("Invalid URDF position limits")
    rates = {key: float(limit.attrib[attr]) if limit is not None and attr in limit.attrib else None
             for key, attr in (("max_velocity", "velocity"), ("max_effort", "effort"))}
    if any(v is not None and (not math.isfinite(v) or v <= 0) for v in rates.values()):
        raise ValueError("URDF velocity/effort limits must be positive")
    axis = numbers(joint.find("axis"), "xyz", "1 0 0")
    norm = math.hypot(*axis)
    if norm == 0:
        raise ValueError("URDF joint axis must be nonzero")
    return {"axis": [v/norm for v in axis], "limits": bounds, **rates}


def read_tree(path, base_link, xml=None):
    """Every joint below base_link in document order, with mimic relations."""
    links, parents = parse(path, xml)
    if base_link not in links:
        raise ValueError("base_link must name a URDF link")

    def below(link):
        seen = set()
        while link != base_link:
            if link in seen or link not in parents:
                return False
            seen.add(link)
            link = parents[link].find("parent").attrib["link"]
        return True

    joints = []
    for child, joint in parents.items():
        if child == base_link or not below(child):
            continue
        kind = joint.attrib["type"]
        if kind != "fixed" and kind not in MOVABLE:
            raise ValueError(f"{joint.attrib['name']}: planar and floating joints are unsupported")
        value = {"name": joint.attrib["name"], "type": kind, "parent": joint.find("parent").attrib["link"],
                 "child": child, "origin": origin(joint)}
        if kind in MOVABLE:
            mimic = joint.find("mimic")
            value.update(motion(joint), mimic=None if mimic is None else {
                "joint": mimic.attrib["joint"], "multiplier": float(mimic.get("multiplier", 1)),
                "offset": float(mimic.get("offset", 0))})
        joints.append(value)
    if not any(joint["type"] in MOVABLE for joint in joints):
        raise ValueError("base_link has no movable descendant joints")
    independent = {joint["name"] for joint in joints if joint["type"] in MOVABLE and joint["mimic"] is None}
    for joint in joints:
        if joint.get("mimic") and joint["mimic"]["joint"] not in independent:
            raise ValueError(f"{joint['name']} must mimic an independent movable joint below base_link")
    return {"base_link": base_link, "links": [base_link] + [joint["child"] for joint in joints], "joints": joints}


def joint_target(value, joints, *, check_limits=True):
    """Finite positions for the given joints, optionally within their URDF limits."""
    if not joints:
        raise ValueError("joint metadata is required")
    vector(value, len(joints), "joint target")
    for position, joint in zip(value, joints):
        limits = joint.get("limits")
        if check_limits and limits is not None and not limits["min"] <= position <= limits["max"]:
            raise ValueError(f"target outside joint limits: {joint['name']}")
    return value


def commanded(tree):
    """Independent movable joints in document order: the device's command vector."""
    return [joint for joint in tree["joints"] if joint["type"] != "fixed" and joint["mimic"] is None]


def positions(tree, measured):
    """Positions of every movable joint whose independent source was measured."""
    values = {}
    for joint in tree["joints"]:
        if joint["type"] == "fixed":
            continue
        mimic = joint["mimic"]
        source = mimic["joint"] if mimic else joint["name"]
        if source in measured:
            values[joint["name"]] = mimic["multiplier"] * measured[source] + mimic["offset"] if mimic else measured[source]
    return values


def displacement(joint, position):
    """Child motion of a movable joint within its origin frame."""
    axis = joint["axis"]
    if joint["type"] == "prismatic":
        return quat_to_mat([0, 0, 0, 1]), [v * position for v in axis]
    s = math.sin(position / 2)
    return quat_to_mat([*(v * s for v in axis), math.cos(position / 2)]), [0, 0, 0]


def joint_transform(joint, position=0.0):
    """Parent-to-child rigid transform of one URDF joint at a scalar position."""
    base = xyzq_to_rt(joint["origin"])
    return base if joint["type"] == "fixed" else compose_rt(base, displacement(joint, position))
