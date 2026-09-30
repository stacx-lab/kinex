#!/usr/bin/env python3
"""Local Grounding DINO detection through the shared model driver protocol."""

import contextlib
import os
from pathlib import Path
import sys
import time

from kinex.driver_protocol import run
from kinex.validation import settings

HERE = Path(__file__).resolve().parent
MODEL = PROCESSOR = None


def load(config):
    global MODEL, PROCESSOR
    if MODEL is not None:
        return
    connection = config["access"]["connection"]
    compute = connection["compute"]
    if connection["kind"] != "process" or compute["kind"] not in ("cpu", "cuda"):
        raise ValueError("Grounding DINO requires a CPU or CUDA process connection")
    device = f"cuda:{compute['index']}" if compute["kind"] == "cuda" else "cpu"
    artifact = next(item for item in config["intrinsics"]["artifacts"] if item["name"] == "checkpoint")
    checkpoint = (HERE / artifact["path"]).resolve()
    if not (checkpoint / "model.safetensors").is_file():
        raise FileNotFoundError(f"checkpoint not provisioned: {checkpoint}")
    os.environ["HF_HOME"] = str(HERE / "hf-cache")
    os.environ["HF_HUB_OFFLINE"] = "1"
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    processor = AutoProcessor.from_pretrained(checkpoint, local_files_only=True, use_fast=False)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(
        checkpoint, local_files_only=True, use_safetensors=True, disable_custom_kernels=True,
    ).to(device).eval()
    MODEL, PROCESSOR = model, processor


def detect(args):
    import torch
    from PIL import Image, ImageDraw

    with Image.open(args["image"]) as source:
        image = source.convert("RGB")
    prompt = args["prompt"].strip().lower()
    if not prompt:
        raise ValueError("prompt must not be blank")
    inputs = PROCESSOR(images=image, text=prompt.rstrip(".") + ".", return_tensors="pt").to(MODEL.device)
    with torch.inference_mode():
        output = MODEL(**inputs)
    detected = PROCESSOR.post_process_grounded_object_detection(
        output, inputs.input_ids, threshold=args["min_score"],
        text_threshold=0.25, target_sizes=[image.size[::-1]],
    )[0]
    results = sorted([
        {"box": box.tolist(), "score": score.item(), "label": label}
        for box, score, label in zip(detected["boxes"], detected["scores"], detected["text_labels"])
    ], key=lambda item: -item["score"])[:args["max_results"]]
    draw = ImageDraw.Draw(image)
    for item in results:
        draw.rectangle(item["box"], outline="red", width=2)
        x, y = item["box"][:2]
        draw.text((x, max(0, y - 12)), f'{item["label"]} {item["score"]:.2f}', fill="red")
    out = HERE / "out"
    out.mkdir(exist_ok=True)
    overlay = out / f"detection_{time.time_ns()}.png"
    image.save(overlay)
    return {"results": results, "file": str(overlay)}


def handle(action, args):
    global MODEL, PROCESSOR
    if action in ("read", "status"):
        return {"loaded": MODEL is not None}
    if action == "unload":
        loaded = MODEL is not None
        MODEL = PROCESSOR = None
        if loaded:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        return {"loaded": False}
    if action not in ("load", "detect"):
        raise ValueError(f"unsupported action: {action}")
    config = settings(HERE)
    load(config)
    if action == "load":
        return {"loaded": True}
    operation = next(item for item in config["intrinsics"]["operations"] if item["name"] == "detect")
    defaults = {key: value["default"] for key, value in operation["input"]["properties"].items() if "default" in value}
    return detect({**defaults, **args})


def respond(action, args):
    try:
        with contextlib.redirect_stdout(sys.stderr):
            return {"ok": True, **handle(action, args)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


if __name__ == "__main__":
    run(respond, lambda: handle("unload", {}))
