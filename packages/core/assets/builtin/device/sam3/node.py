"""SAM3 open-vocabulary segmentation served as a Kinex model node."""
import tempfile
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from rclpy.node import Node
from sam3.model.sam3_image_processor import Sam3Processor
from sam3.model_builder import build_sam3_image_model

from kinex.node import json_service

HERE = Path(__file__).resolve().parent


def placement(compute):
    if compute["kind"] == "cuda":
        torch.cuda.set_device(compute["index"])
        torch.backends.cuda.matmul.allow_tf32 = torch.backends.cudnn.allow_tf32 = True
        return torch.device("cuda", compute["index"])
    if compute["kind"] == "cpu":
        return torch.device("cpu")
    raise ValueError("SAM3 runs on cpu or cuda")


def numeric(value):
    return np.asarray(value.detach().float().cpu() if hasattr(value, "detach") else value)


def results(masks, boxes, scores, label, min_score, max_results):
    """Ranked detections with each binary mask written to a temporary PNG."""
    found = []
    for index in np.argsort(-scores, kind="stable"):
        if len(found) == max_results or scores[index] < min_score:
            break
        mask = masks[index] > 0
        if not mask.any():
            continue
        with tempfile.NamedTemporaryFile(prefix="kinex-mask-", suffix=".png", delete=False) as file:
            Image.fromarray(mask.astype(np.uint8) * 255).save(file, format="PNG")
        found.append({"box": [float(value) for value in boxes[index]], "score": float(scores[index]),
                      "label": label, "mask": file.name})
    return found


class Sam3(Node):
    def __init__(self, profile, context):
        super().__init__("kinex_" + profile["name"].replace("-", "_"), context=context)
        checkpoint = HERE / next(item for item in profile["artifacts"] if item["name"] == "checkpoint")["path"]
        if not checkpoint.is_file():
            raise FileNotFoundError(f"checkpoint not provisioned: {checkpoint}; run setup.sh")
        self.device = placement(profile["compute"])
        self.model = build_sam3_image_model(
            checkpoint_path=str(checkpoint), load_from_HF=False, device="cpu", enable_inst_interactivity=True,
        ).to(self.device)
        self.processor = Sam3Processor(self.model, device=str(self.device), confidence_threshold=0.0)
        json_service(self, profile["operations"]["detect"], self.detect)
        json_service(self, profile["operations"]["segment_point"], self.segment_point)

    def predict(self, image, prompt):
        with Image.open(image) as source:
            picture = source.convert("RGB")
        with torch.inference_mode(), torch.autocast(self.device.type, dtype=torch.bfloat16):
            return prompt(self.processor.set_image(picture))

    def detect(self, image, prompt, min_score=0.25, max_results=10):
        output = self.predict(image, lambda state: self.processor.set_text_prompt(state=state, prompt=prompt))
        if output.get("scores") is None or not len(output["scores"]):
            return {"results": []}
        masks = numeric(output["masks"])
        masks = masks.squeeze(1) if masks.ndim == 4 else masks
        return {"results": results(masks, numeric(output["boxes"]), numeric(output["scores"]), prompt, min_score, max_results)}

    def segment_point(self, image, point, max_results=3):
        masks, scores, _ = self.predict(image, lambda state: self.model.predict_inst(
            state, point_coords=np.array([point], dtype=np.float32), point_labels=np.array([1]), multimask_output=True))
        masks = numeric(masks)
        boxes = [[xs.min(), ys.min(), xs.max(), ys.max()] if xs.size else [0, 0, 0, 0]
                 for ys, xs in (np.nonzero(mask > 0) for mask in masks)]
        return {"results": results(masks, boxes, numeric(scores), "point", 0, max_results)}


def create(profile, context):
    return Sam3(profile, context)
