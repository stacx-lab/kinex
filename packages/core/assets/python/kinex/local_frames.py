"""Explicit and model-defined device-local frames."""

from kinex.geometry import compose_rt, xyzq_to_rt
from kinex.motion import pose


def frame_definitions(profile):
    facts = profile["intrinsics"]
    frames = dict(facts.get("frames", {}))
    if profile["type"] not in {"joint", "dexterous_hand"}:
        return frames
    kinematics = facts.get("kinematics")
    computed = [(kinematics["frame"], "kinematics")] if kinematics else []
    geometry = facts.get("geometry")
    if geometry:
        computed.extend((finger["tip_frame"], "hand") for finger in geometry.get("fingers", {}).values())
        if geometry.get("center"):
            computed.append((geometry["center"]["frame"], "hand"))
    for name, source in computed:
        if name in frames:
            raise ValueError(f"Duplicate model-defined frame {name!r}; remove its frames entry")
        frames[name] = {"parent_frame": None, "source": source}
    return frames


def fixed_transform(frames, frame, root=None):
    result = xyzq_to_rt([0, 0, 0, 0, 0, 0, 1])
    seen = set()
    while frame != root:
        if frame is None or frame not in frames or frame in seen:
            raise ValueError(f"No fixed frame path to {root!r}")
        seen.add(frame)
        definition = frames[frame]
        translation, rotation = definition.get("translation_m"), definition.get("rotation_xyzw")
        if translation is None or rotation is None:
            raise ValueError(f"Unknown transform for frame {frame!r}")
        result = compose_rt(xyzq_to_rt(pose([*translation, *rotation])), result)
        frame = definition["parent_frame"]
    return result
