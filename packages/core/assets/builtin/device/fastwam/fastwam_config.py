"""Pinned model variants and typed Kinex profile; no ML imports at discovery."""

import json
from pathlib import Path

REVISION = "7faa71108368fbb3b6885649f112af607427a2d4"
VARIANTS = {
    "libero_uncond_2cam224": ("libero_2cam", "fastwam", 2, 8, 7, 5.0),
    "libero_optional_idm_2cam224": ("libero_2cam", "fastwam_optional_idm", 2, 8, 7, 1.0),
    "robotwin_uncond_3cam_384": ("robotwin", "fastwam", 3, 14, 14, 5.0),
}


def array(items, size=None):
    return {"type": "array", "items": items, **({"minItems": size, "maxItems": size} if size else {})}


def make_profile(directory, variant, index=0):
    directory = Path(directory)
    _, _, cameras, state, action, _ = VARIANTS[variant]
    fields = {
        "obs": {"type": "object", "required": ["images", "state"], "properties": {
            "images": array({"type": "string", "format": "path"}, cameras),
            "state": array({"type": "number"}, state),
        }},
        "task": {"type": "string", "minLength": 1},
        "seed": {"type": "integer", "minimum": 0, "default": 0},
        "num_inference_steps": {"type": "integer", "minimum": 1, "maximum": 100, "default": 10},
        "compile_action_infer": {"type": "boolean"},
    }
    if variant == "libero_optional_idm_2cam224":
        fields["action_infer_mode"] = {"type": "string", "enum": ["first_frame", "idm"]}
    artifacts = json.loads((directory / "artifacts.json").read_text())
    return {
        "name": directory.name, "type": "model", "loaded": False,
        "access": {"source": "user", "connection": {"kind": "process", "compute": {"kind": "cuda", "index": index}},
                   "driver": {"entry": "driver.py", "interpreter": str(directory / "venv/bin/python"),
                              "actions": ["load", "unload", "status", "read", "infer"], "persistent": True, "timeout_s": 600}},
        "intrinsics": {"source": "default", "family": "fastwam", "variant": variant,
            "implementation": {"repository": "https://github.com/yuantianyuan01/FastWAM.git", "revision": REVISION},
            "artifacts": [{"name": f"artifact_{i}", "path": f"weights/{a['repo']}/{a['filename']}",
                           "source": {"kind": "huggingface", **{k: a[k] for k in ["repo", "revision", "filename"]}}}
                          for i, a in enumerate(artifacts)],
            "operations": [{"name": "infer", "input": {"type": "object", "required": ["obs", "task"], "properties": fields},
                            "output": {"type": "object", "required": ["actions"], "properties": {
                                "actions": array(array({"type": "number"}, action), 32),
                                "inference_s": {"type": "number", "minimum": 0},
                            }}}]},
    }
