"""Call-local frame forests with optional estimated bridges and lazy live reads."""

from kinex import device, fail, profile
from kinex.frame_path import Edge, compose_path, label, select_path
from kinex.geometry import mount_to_rt, pose_to_rt, rt_to_pose, xyzq_to_rt
from kinex.motion import quaternion
from kinex.local_frames import frame_definitions
from kinex.validation import vector


def _missing(value):
    return value is None or value == "???"


class _FrameError(ValueError):
    """Missing topology, which can be irrelevant above the requested path."""


class _Resolver:
    """Each profile, declared edge, transform and device sample is cached per call."""

    def __init__(self, readings):
        self.profiles = {}
        self.definitions = {}
        self.readings = dict(readings or {})
        self.parents = {}
        self.ends = {}

    def profile(self, name):
        if name not in self.profiles:
            self.profiles[name] = profile(name, optional=True)
        prof = self.profiles[name]
        if prof is not None:
            return prof
        if name == "world":
            return {"type": "world", "intrinsics": {"frames": {}}}
        raise _FrameError(f'no device "{name}" in the frame graph')

    def read(self, name):
        if name not in self.readings:
            self.readings[name] = device(name).get("data") or {}
        return self.readings[name]

    def frames(self, name):
        if name not in self.definitions:
            self.definitions[name] = frame_definitions(self.profile(name))
        return self.definitions[name]

    def node(self, ref):
        if not isinstance(ref, str) or not ref:
            raise _FrameError("provide a nonempty frame reference")
        name, _, frame = ref.partition(":")
        frame = "" if frame == name else frame
        prof = self.profile(name)
        if prof.get("type") in ("model", "detection", "segmentation"):
            raise _FrameError(f'"{name}" is a model device — it has no physical pose')
        if frame and frame not in self.frames(name):
            raise _FrameError(f'device "{name}" does not declare frame "{frame}"')
        return name, frame

    def frame_pose(self, node):
        name, frame = node
        prof = self.profile(name)
        if prof["type"] in {"joint", "dexterous_hand"}:
            from kinex.joints import JointDevice
            facts = prof["intrinsics"]
            source = self.frames(name)[frame]["source"]
            fk = (facts.get("kinematics") or {}).get("fk")
            if source == "kinematics" and not fk:
                fail(f'device "{name}" has no FK for frame "{frame}"')
            args = {"joints": self.read(name)["positions"], "frame": frame,
                    "reference_frame": None}
            if source == "kinematics" and fk == "driver":
                return xyzq_to_rt(device(name, "fk", **args)["data"]["pose"])
            return xyzq_to_rt(JointDevice(prof).fk(**args)["pose"])
        value = self.read(name).get("frame_poses", {}).get(frame)
        if value is None:
            fail(f'device "{name}" reported no pose for {label(node)}')
        return xyzq_to_rt(value)

    def measured_pose(self, name):
        value = self.read(name).get("pose")
        if not isinstance(value, dict):
            fail(f'device "{name}" reported no measured pose')
        return pose_to_rt({"translation": value["translation_m"], "rotation": value["rotation_xyzw"]})

    def parent_edge(self, node):
        name, frame = node
        prof = self.profile(name)
        if frame:
            definition = self.frames(name)[frame]
            parent = (name, definition["parent_frame"] or "")
            if "source" in definition:
                return Edge(node, parent, "live", lambda: self.frame_pose(node))
            translation, rotation = definition["translation_m"], definition["rotation_xyzw"]
            if translation is None or rotation is None:
                if prof["type"] not in {"joint", "dexterous_hand", "gripper", "world"}:
                    return Edge(node, parent, "live", lambda: self.frame_pose(node))
                return Edge(node, parent, "static", None, f"intrinsics:{name} frame {frame} transform is unknown")
            return Edge(node, parent, "static", lambda: xyzq_to_rt([*translation, *rotation]))
        if prof.get("type") == "world":
            return None
        spatial = prof.get("extrinsics") or {}
        if prof.get("type") == "velocity":
            raise _FrameError(f"{name} is unlocalized — supply an explicit frame estimate")
        if "pose_frame" in spatial:
            reference = spatial["pose_frame"]
            if _missing(reference):
                raise _FrameError(f"{name} is unlocalized" if reference is None else f"extrinsics:{name} pose_frame is ???")
            return Edge(node, self.node(reference), "dynamic", lambda: self.measured_pose(name))
        mount = spatial.get("mount")
        if _missing(mount):
            raise _FrameError(f"extrinsics:{name} mount is unknown — inspect the device profile")
        parent = self.node(f"{mount['parent']}:{mount['parent_frame']}")
        if any(_missing(mount.get(key)) for key in ("translation_m", "rotation_xyzw")):
            return Edge(node, parent, "static", None, f"extrinsics:{name} mount is incomplete — inspect the device profile")
        return Edge(node, parent, "static", lambda: mount_to_rt(mount))

    def discover(self, ref):
        try:
            start = node = self.node(ref)
        except _FrameError as error:
            fail(str(error))
        seen = set()
        while True:
            if node in seen:
                fail(f"frame cycle at {label(node)} — fix the pose references")
            if node in self.parents:
                return start
            seen.add(node)
            try:
                edge = self.parent_edge(node)
            except _FrameError as error:
                self.ends[node] = str(error)
                edge = None
            self.parents[node] = edge
            if edge is None:
                return start
            node = edge.parent

    def ancestors(self, node):
        while True:
            yield node
            edge = self.parents[node]
            if edge is None:
                return
            node = edge.parent

    def disconnected(self, nodes):
        reasons = {}
        for node in nodes:
            for ancestor in self.ancestors(node):
                edge = self.parents[ancestor]
                reason = edge.reason if edge is not None else self.ends.get(ancestor)
                if reason:
                    reasons[reason] = None
        detail = f" — {'; '.join(reasons)}" if reasons else ""
        fail(f"no usable frame path connects {', '.join(map(label, nodes))}{detail}")

    def estimates(self, estimates):
        if not isinstance(estimates, list):
            raise ValueError("estimates must be an array")
        edges = []
        for index, estimate in enumerate(estimates):
            prefix = f"estimates[{index}]"
            if not isinstance(estimate, dict) or set(estimate) != {"child", "parent", "translation_m", "rotation_xyzw"}:
                raise ValueError(f"{prefix} needs child, parent, translation_m and rotation_xyzw")
            translation = vector(estimate["translation_m"], 3, f"{prefix}.translation_m")
            rotation = quaternion(estimate["rotation_xyzw"], f"{prefix}.rotation_xyzw")
            child, parent = (self.discover(estimate[key]) for key in ("child", "parent"))
            rt = pose_to_rt({"translation": translation, "rotation": rotation})
            edges.append(Edge(child, parent, "estimated", lambda rt=rt: rt, estimate_index=index))
        return edges


def common_frame(refs, *, readings=None):
    """Find the deepest common ancestor, or highest calibrated ancestor of one ref.

    Returns {frame, transforms, chains}, with directed provenance in each chain.
    Unknown edges above the selected ancestor are irrelevant; required live reads
    must succeed. Estimated bridges belong to pose(), which has an explicit target.
    """
    if not refs:
        fail("provide at least one frame reference")
    resolver = _Resolver(readings)
    nodes = [resolver.discover(ref) for ref in refs]
    if len(nodes) == 1:
        target = nodes[0]
        while (edge := resolver.parents[target]) is not None and edge.resolve is not None:
            target = edge.parent
    else:
        chains = [list(resolver.ancestors(node)) for node in nodes]
        shared = set(chains[0]).intersection(*chains[1:])
        target = next((node for node in chains[0] if node in shared), None)
        if target is None:
            resolver.disconnected(nodes)
    transforms, chains = [], []
    for node in nodes:
        path = []
        while node != target:
            edge = resolver.parents[node]
            path.append((edge, False))
            node = edge.parent
        rt, used = compose_path(path)
        transforms.append(rt)
        chains.append(used)
    return {"frame": label(target), "transforms": transforms, "chains": chains}


def pose(child, parent, *, readings=None, estimates=None):
    """Child expressed in parent: p_parent = R * p_child + t, quaternion xyzw.

    Returns translation, rotation, ordered path and estimated_links. Call-local
    estimates use child, parent, translation_m and unit rotation_xyzw. Paths prefer
    fewer estimates, then fewer edges, with direction-independent ties. Each path
    entry has from, to, kind and inverse, plus estimate_index for supplied links.
    Only the chosen path reads devices; read failures remain errors.
    """
    resolver = _Resolver(readings)
    child, parent = resolver.discover(child), resolver.discover(parent)
    extra = resolver.estimates([] if estimates is None else estimates)
    edges = [edge for edge in resolver.parents.values() if edge is not None]
    path = select_path(edges + extra, child, parent)
    if path is None:
        resolver.disconnected([child, parent])
    rt, used = compose_path(path)
    return {**rt_to_pose(rt), "path": used, "estimated_links": sum(edge.kind == "estimated" for edge, _ in path)}
