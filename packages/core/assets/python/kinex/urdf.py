"""Read device-selected URDF chains and trees; no SDK, simulator or numerical dependencies."""

import math
from pathlib import Path
from xml.etree import ElementTree

from kinex.geometry import compose_rt, quat_to_mat, xyzq_to_rt
from kinex.motion import vector

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


def read_chain(path, base_link, tip_link, xml=None):
    links, parents = parse(path, xml)
    if base_link not in links or tip_link not in links or base_link == tip_link:
        raise ValueError("URDF requires unique links and distinct existing base_link/tip_link")
    selected, visited = [], set()
    current = tip_link
    while current != base_link:
        if current in visited or current not in parents:
            raise ValueError("tip_link is not a descendant of base_link in an acyclic chain")
        visited.add(current)
        joint = parents[current]
        selected.append(joint)
        current = joint.find("parent").attrib["link"]
    joints, chain = [], []
    for joint in reversed(selected):
        link = {"origin": origin(joint)}
        kind = joint.attrib["type"]
        if kind == "fixed":
            chain.append(link)
            continue
        if kind not in MOVABLE or joint.find("mimic") is not None:
            raise ValueError("Selected chain must contain independent scalar joints; mimic/planar/floating joints are unsupported")
        values = motion(joint)
        link.update(joint=len(joints), axis=values["axis"], anchor=[0, 0, 0], reference=0)
        joints.append({"name": joint.attrib["name"], "type": kind, "limits": values["limits"],
                       "max_velocity": values["max_velocity"], "max_effort": values["max_effort"]})
        chain.append(link)
    if not joints:
        raise ValueError("Selected chain has no movable joints")
    return {"joints": joints, "chain": chain}


def read_tree(path, base_link, xml=None):
    """Every joint below base_link, with mimic relations, for publishing link frames."""
    links, parents = parse(path, xml)
    if base_link not in links:
        raise ValueError("base_link must name a URDF link")
    children = {}
    for joint in parents.values():
        children.setdefault(joint.find("parent").attrib["link"], []).append(joint)
    joints, pending, reached = [], [base_link], {base_link}
    while pending:
        for joint in children.get(pending.pop(), []):
            child = joint.find("child").attrib["link"]
            if child in reached:
                raise ValueError("URDF links below base_link must form a tree")
            reached.add(child)
            pending.append(child)
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
    return {"base_link": base_link, "links": sorted(reached), "joints": joints}


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


def joint_transform(joint, position=0.0):
    """Parent-to-child rigid transform of one URDF joint at a scalar position."""
    base = xyzq_to_rt(joint["origin"])
    if joint["type"] == "fixed":
        return base
    axis = joint["axis"]
    if joint["type"] == "prismatic":
        return compose_rt(base, (quat_to_mat([0, 0, 0, 1]), [v * position for v in axis]))
    s = math.sin(position / 2)
    return compose_rt(base, (quat_to_mat([*(v * s for v in axis), math.cos(position / 2)]), [0, 0, 0]))
