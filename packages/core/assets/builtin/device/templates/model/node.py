"""Reference model node serving a TorchScript image model through one Json operation.

Replace the loading and inference with the model's SDK. Loading happens in the
factory, so load fails before serving and unload frees the model with its process.
"""
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from rclpy.node import Node

from kinex.communication import json_service

HERE = Path(__file__).resolve().parent


def placement(compute):
    if compute["kind"] == "remote":
        raise ValueError("a remote model calls its service instead of loading weights")
    return f"cuda:{compute['index']}" if compute["kind"] == "cuda" else compute["kind"]


class Model(Node):
    def __init__(self, profile, context):
        super().__init__("kinex_" + profile["name"].replace("-", "_"), context=context)
        weights = HERE / next(item for item in profile["artifacts"] if item["name"] == "weights")["path"]
        if not weights.is_file():
            raise FileNotFoundError(f"weights not provisioned: {weights}")
        self.device = placement(profile["compute"])
        self.model = torch.jit.load(weights, map_location=self.device).eval()
        json_service(self, profile["operations"]["infer"], self.infer)

    def infer(self, image):
        with Image.open(image) as source:
            pixels = np.asarray(source.convert("RGB"), dtype=np.float32) / 255
        batch = torch.from_numpy(pixels).permute(2, 0, 1).unsqueeze(0).to(self.device)
        with torch.inference_mode():
            return {"outputs": self.model(batch).squeeze(0).tolist()}


def create(profile, context):
    return Model(profile, context)
