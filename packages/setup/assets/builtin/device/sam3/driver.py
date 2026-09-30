#!/usr/bin/env python3
"""SAM3 instance of the model contract; settings come from profile.yaml.

The persistent process loads local weights on load. Status and read
report readiness without loading. SDK output goes to stderr.
"""

import contextlib
from kinex.driver_protocol import run
import os
import pathlib
import sys
import time

MODEL = None
PROCESSOR = None
DEVICE = "cuda"
HERE = pathlib.Path(__file__).parent
OUT = HERE / "out"


def profile():
    import yaml

    return yaml.safe_load((HERE / "profile.yaml").read_text())


def compute_placement():
    connection = profile()["access"]["connection"]
    if connection["kind"] != "process":
        raise ValueError("this SAM3 instance requires a process connection")
    compute = connection["compute"]
    if compute["kind"] == "cuda":
        return f"cuda:{compute['index']}"
    if compute["kind"] == "cpu":
        return "cpu"
    raise ValueError("this SAM3 implementation supports CPU or CUDA")


def checkpoint_path():
    artifact = next(item for item in profile()["intrinsics"]["artifacts"] if item["name"] == "checkpoint")
    checkpoint = (HERE / artifact["path"]).resolve()
    if not checkpoint.is_file():
        raise FileNotFoundError(f"checkpoint not provisioned: {checkpoint}")
    return checkpoint


def load():
    global MODEL, PROCESSOR, DEVICE
    if PROCESSOR is not None:
        return
    DEVICE = compute_placement()
    checkpoint = checkpoint_path()
    os.environ["HF_HOME"] = str(HERE / "hf-cache")
    os.environ["HF_HUB_OFFLINE"] = "1"
    import torch
    from sam3.model.sam3_image_processor import Sam3Processor
    from sam3.model_builder import build_sam3_image_model

    if DEVICE.startswith("cuda"):
        torch.cuda.set_device(int(DEVICE.split(":")[-1]))
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    model = build_sam3_image_model(
        checkpoint_path=str(checkpoint), load_from_HF=False,
        device="cpu", enable_inst_interactivity=True,
    ).to(DEVICE)
    processor = Sam3Processor(model, device=DEVICE, confidence_threshold=0.0)
    MODEL, PROCESSOR = model, processor


def operation_args(name, args):
    operation = next(item for item in profile()["intrinsics"]["operations"] if item["name"] == name)
    defaults = {key: value["default"] for key, value in operation["input"]["properties"].items() if "default" in value}
    return {**defaults, **args}


def _to_numpy(tensor):
    import numpy as np

    if hasattr(tensor, "detach"):
        t = tensor.detach().cpu()
        return t.float().numpy() if str(t.dtype) == "torch.bfloat16" else t.numpy()
    return np.asarray(tensor)


def _save_results(image_path, masks, boxes, scores, label, max_results, min_score=0):
    """Write per-detection mask PNGs + one overlay; return the results list."""
    import numpy as np
    from PIL import Image, ImageDraw

    OUT.mkdir(exist_ok=True)
    stamp = str(time.time_ns())
    image = Image.open(image_path).convert("RGB")
    overlay = image.copy()
    draw = ImageDraw.Draw(overlay)

    order = np.argsort(-np.asarray(scores), kind="stable")
    results = []
    for index in order:
        if len(results) == max_results or scores[index] < min_score:
            break
        mask = np.asarray(masks[index]) > 0
        if not mask.any():
            continue
        rank = len(results)
        mask_path = OUT / f"mask_{stamp}_{rank}.png"
        Image.fromarray(mask.astype("uint8") * 255).save(mask_path)
        # Blend the best mask into the overlay; box + score for all kept ones.
        if rank == 0:
            tint = np.array(overlay)
            tint[mask] = tint[mask] // 2 + np.array([15, 72, 128], dtype="uint8")
            overlay = Image.fromarray(tint)
            draw = ImageDraw.Draw(overlay)
        x1, y1, x2, y2 = [float(value) for value in boxes[index]]
        draw.rectangle([x1, y1, x2, y2], outline="red", width=2)
        draw.text((x1, max(0, y1 - 12)), f"{float(scores[index]):.2f}", fill="red")
        results.append(
            {
                "box": [x1, y1, x2, y2],
                "score": float(scores[index]),
                "label": label,
                "mask": str(mask_path),
            }
        )
    overlay_path = OUT / f"overlay_{stamp}.png"
    overlay.save(overlay_path)
    return results, str(overlay_path)


def read(args):
    return status(args)


def load_hook(args):
    """The /load lifecycle hook: ensure the weights are loaded (the explicit warm)."""
    load()
    return {"loaded": True, "compute": DEVICE}


def status(args):
    """The /ping probe: cheap status facts, never inference."""
    return {"loaded": PROCESSOR is not None, "compute": DEVICE if PROCESSOR is not None else compute_placement()}


def unload_hook(args):
    """The /unload lifecycle hook: drop the model and free the GPU before the
    serve process is killed."""
    global MODEL, PROCESSOR
    loaded = MODEL is not None or PROCESSOR is not None
    MODEL = None
    PROCESSOR = None
    if not loaded:
        return {"unloaded": True}
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
    return {"unloaded": True}


def detect(args):
    """Text-prompt detection with per-object segmentation masks."""
    args = operation_args("detect", args)
    load()
    import torch
    from PIL import Image

    image = Image.open(args["image"]).convert("RGB")
    with torch.inference_mode(), torch.autocast("cuda" if "cuda" in DEVICE else "cpu", dtype=torch.bfloat16):
        state = PROCESSOR.set_image(image)
        output = PROCESSOR.set_text_prompt(state=state, prompt=args["prompt"])
    masks, boxes, scores = output.get("masks"), output.get("boxes"), output.get("scores")
    if masks is None or boxes is None or len(_to_numpy(scores)) == 0:
        return {"results": []}
    masks = _to_numpy(masks)
    if masks.ndim == 4 and masks.shape[1] == 1:
        masks = masks.squeeze(1)
    results, overlay = _save_results(
        args["image"], masks, _to_numpy(boxes), _to_numpy(scores), args["prompt"], args["max_results"], args["min_score"]
    )
    return {"results": results, "file": overlay}


def segment_point(args):
    """Point-prompt segmentation: {image, point: [u, v]}."""
    args = operation_args("segment_point", args)
    load()
    import numpy as np
    import torch
    from PIL import Image

    image = Image.open(args["image"]).convert("RGB")
    with torch.inference_mode(), torch.autocast("cuda" if "cuda" in DEVICE else "cpu", dtype=torch.bfloat16):
        state = PROCESSOR.set_image(image)
        masks, scores, _ = MODEL.predict_inst(
            state,
            point_coords=np.array([list(args["point"])], dtype=np.float32),
            point_labels=np.array([1], dtype=np.int64),
            multimask_output=True,
        )
    masks, scores = np.asarray(masks), np.asarray(scores)
    if masks.size == 0:
        return {"results": []}
    boxes = []
    for mask in masks:
        ys, xs = np.nonzero(mask > 0)
        boxes.append([xs.min(), ys.min(), xs.max(), ys.max()] if xs.size else [0, 0, 0, 0])
    results, overlay = _save_results(args["image"], masks, boxes, scores, "point", args["max_results"])
    return {"results": results, "file": overlay}


ACTIONS = {
    "read": read,
    "load": load_hook,
    "unload": unload_hook,
    "status": status,
    "detect": detect,
    "segment_point": segment_point,
}


def handle(action, args):
    handler = ACTIONS.get(action)
    if handler is None:
        return {"ok": False, "error": f"unknown action {action!r}; have {sorted(ACTIONS)}"}
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = handler(args)
        return {"ok": True, **result}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def main():
    run(handle, lambda: unload_hook({}))


if __name__ == "__main__":
    main()
