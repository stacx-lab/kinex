"""Explicit and model-defined device-local frames."""

from kinex.geometry import compose_rt, xyzq_to_rt
from kinex.motion import pose


def frame_definitions(profile):
    frames = dict(profile.get("frames", {}))
    kinematics = profile.get("kinematics") if profile["type"] in {"joint", "dexterous_hand"} else None
    computed = [(kinematics["frame"], "kinematics")] if kinematics else []
    geometry = profile.get("geometry") if profile["type"] == "dexterous_hand" else None
    if geometry:
        computed.extend((finger["tip_frame"], "hand") for finger in geometry.get("fingers", {}).values())
        if geometry.get("center"):
            computed.append((geometry["center"]["frame"], "hand"))
    for name, source in computed:
        definition = frames.get(name)
        if (definition is None or definition["parent"] != f"{profile['name']}:base"
                or definition.get("translation_m") is not None or definition.get("rotation_xyzw") is not None):
            raise ValueError(f"Model frame {name!r} requires explicit base parent and null static transform")
        frames[name] = {**definition, "source": source}
    return {name: {**value, "parent": (
        value["parent"].split(":", 1)[1] if value["parent"] and value["parent"].startswith(profile["name"] + ":")
        else value["parent"])} for name, value in frames.items()}


def fixed_transform(frames, frame, root="base"):
    frame = "base" if frame is None else frame
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
        frame = definition["parent"]
    return result
