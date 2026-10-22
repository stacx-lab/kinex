"""Grounding DINO open-vocabulary detection served as a Kinex model node."""
from pathlib import Path

import torch
from PIL import Image
from rclpy.node import Node
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

from kinex.communication import json_service

HERE = Path(__file__).resolve().parent


def placement(compute):
    if compute["kind"] == "cuda":
        return f"cuda:{compute['index']}"
    if compute["kind"] == "cpu":
        return "cpu"
    raise ValueError("Grounding DINO runs on cpu or cuda")


class GroundingDino(Node):
    def __init__(self, profile, context):
        super().__init__("kinex_" + profile["name"].replace("-", "_"), context=context)
        weights = HERE / next(item for item in profile["artifacts"] if item["name"] == "checkpoint")["path"]
        if not (weights / "model.safetensors").is_file():
            raise FileNotFoundError(f"checkpoint not provisioned: {weights}; run setup.sh")
        self.processor = AutoProcessor.from_pretrained(weights, local_files_only=True, use_fast=False)
        self.model = AutoModelForZeroShotObjectDetection.from_pretrained(
            weights, local_files_only=True, use_safetensors=True, disable_custom_kernels=True,
        ).to(placement(profile["compute"])).eval()
        json_service(self, profile["operations"]["detect"], self.detect)

    def detect(self, image, prompt, min_score=0.25, max_results=10):
        prompt = prompt.strip().lower().rstrip(".")
        if not prompt or not 0 <= min_score <= 1 or max_results < 1:
            raise ValueError("detect requires a prompt, min_score in [0, 1] and max_results >= 1")
        with Image.open(image) as source:
            picture = source.convert("RGB")
        inputs = self.processor(images=picture, text=prompt + ".", return_tensors="pt").to(self.model.device)
        with torch.inference_mode():
            output = self.model(**inputs)
        found = self.processor.post_process_grounded_object_detection(
            output, inputs.input_ids, threshold=min_score,
            text_threshold=0.25, target_sizes=[picture.size[::-1]],
        )[0]
        ranked = sorted(zip(found["scores"].tolist(), found["boxes"].tolist(), found["text_labels"]), key=lambda item: -item[0])
        return {"results": [{"box": box, "score": score, "label": label} for score, box, label in ranked[:max_results]]}


def create(profile, context):
    return GroundingDino(profile, context)
