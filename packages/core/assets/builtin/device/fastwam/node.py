"""FastWAM action inference served as a Kinex model node; robot execution stays in tools."""
import time
from pathlib import Path

import numpy as np
import torch
from fastwam.datasets.lerobot.utils.normalizer import LinearNormalizer, load_dataset_stats_from_json
from fastwam.models.wan22.fastwam import FastWAM
from fastwam.models.wan22.fastwam_optional_idm import FastWAMOptionalIDM
from omegaconf import OmegaConf
from PIL import Image
from rclpy.node import Node

from kinex.node import json_service, node_name, placement
from kinex.lib.geometry import vector

HERE = Path(__file__).resolve().parent
OPTIONAL_IDM = "libero_optional_idm_2cam224"
HORIZON = 32
# variant: data config, model config, cameras, state width, action width, action sigma shift
VARIANTS = {
    "libero_uncond_2cam224": ("libero_2cam", "fastwam", 2, 8, 7, 5.0),
    OPTIONAL_IDM: ("libero_2cam", "fastwam_optional_idm", 2, 8, 7, 1.0),
    "robotwin_uncond_3cam_384": ("robotwin", "fastwam", 3, 14, 14, 5.0),
}


def create_model(config, variant, device):
    extra = ({"action_idm_prob": config["action_idm_prob"], "video_cond_noise_prob": config["video_cond_noise_prob"]}
             if variant == OPTIONAL_IDM else {})
    return (FastWAMOptionalIDM if variant == OPTIONAL_IDM else FastWAM).from_wan22_pretrained(
        device=device, torch_dtype=torch.bfloat16,
        model_id=config["model_id"], tokenizer_model_id=config["tokenizer_model_id"],
        tokenizer_max_len=config["tokenizer_max_len"], load_text_encoder=True,
        proprio_dim=config["proprio_dim"], redirect_common_files=False,
        video_dit_config=config["video_dit_config"], action_dit_config=config["action_dit_config"],
        action_dit_pretrained_path=None, skip_dit_load_from_pretrain=True,
        video_train_shift=config["video_scheduler"]["train_shift"],
        video_infer_shift=config["video_scheduler"]["infer_shift"],
        action_train_shift=config["action_scheduler"]["train_shift"],
        action_infer_shift=VARIANTS[variant][-1], **extra,
    )


def image_array(paths, variant):
    """Input paths already use the evaluator's orientation; only resize and pack."""
    images = [Image.open(path).convert("RGB") for path in paths]
    if variant.startswith("libero_"):
        result = []
        for image in images:
            width, height = image.size
            scale = max(224 / width, 224 / height)
            image = image.resize((round(width * scale), round(height * scale)), Image.Resampling.BILINEAR)
            left, top = (image.width - 224) // 2, (image.height - 224) // 2
            result.append(np.asarray(image.crop((left, top, left + 224, top + 224))))
        return np.concatenate(result, axis=1)
    head, left, right = [np.asarray(image.resize(size, Image.Resampling.BILINEAR))
                         for image, size in zip(images, [(320, 256), (160, 128), (160, 128)], strict=True)]
    return np.concatenate([head, np.concatenate([left, right], axis=1)], axis=0)


def decode_actions(actions, variant):
    """Convert denormalized predictions to physical action coordinates."""
    actions = np.asarray(actions, dtype=np.float32).copy()
    if not np.isfinite(actions).all():
        raise ValueError("FastWAM returned nonfinite actions")
    if variant.startswith("libero_"):
        actions[:, :6] = np.clip(actions[:, :6], -1, 1) * [0.05, 0.05, 0.05, 0.5, 0.5, 0.5]
        actions[:, -1] = np.sign(1 - 2 * actions[:, -1])
    return actions.tolist()


class FastWam(Node):
    def __init__(self, profile, context):
        super().__init__(node_name(profile), context=context)
        self.variant = profile["variant"]
        if self.variant not in VARIANTS:
            raise ValueError(f"unsupported FastWAM variant: {self.variant}")
        device = placement(profile["compute"], ("cuda",))
        # Fail before allocating memory; load never downloads artifacts.
        artifacts = {item["name"]: HERE / item["path"] for item in profile["artifacts"]}
        missing = [str(path) for path in artifacts.values() if not path.is_file()]
        if missing:
            raise FileNotFoundError(f"artifacts not provisioned: {', '.join(missing)}; run setup.sh")
        torch.cuda.set_device(device)
        data, model, *_ = VARIANTS[self.variant]
        config = OmegaConf.to_container(OmegaConf.create({
            "data": OmegaConf.load(HERE / "source/configs/data" / f"{data}.yaml"),
            "model": OmegaConf.load(HERE / "source/configs/model" / f"{model}.yaml"),
        }), resolve=True)
        self.model = create_model(config["model"], self.variant, device)
        # Upstream's loader tolerates missing trained weights; deployment must not.
        payload = torch.load(artifacts["checkpoint"], map_location="cpu", weights_only=True)
        self.model.mot.load_state_dict(payload["mot"], strict=True)
        self.model.proprio_encoder.load_state_dict(payload["proprio_encoder"], strict=True)
        del payload
        self.model.eval()
        processor = config["data"]["train"]["processor"]
        self.normalizer = LinearNormalizer(
            shape_meta=processor["shape_meta"], use_stepwise_action_norm=False,
            default_mode=processor["norm_default_mode"], exception_mode=processor["norm_exception_mode"],
            stats=load_dataset_stats_from_json(str(artifacts["dataset_stats"])),
        )
        json_service(self, profile["operations"]["infer"], self.infer)

    def infer(self, obs, task, seed=0, num_inference_steps=10, compile_action_infer=False, action_infer_mode="first_frame"):
        _, _, cameras, state_width, action_width, sigma = VARIANTS[self.variant]
        if len(obs["images"]) != cameras:
            raise ValueError(f"expected {cameras} camera image paths")
        state = vector(obs["state"], state_width, "proprioception")
        pixels = image_array(obs["images"], self.variant)
        x = torch.from_numpy(pixels.copy()).permute(2, 0, 1).unsqueeze(0).to(self.model.device, self.model.torch_dtype)
        x = x * (2.0 / 255.0) - 1.0
        proprio = self.normalizer.normalizers["state"]["default"].forward(torch.tensor([state], dtype=torch.float32))
        options = {"action_infer_mode": action_infer_mode, "num_video_frames": 9} if self.variant == OPTIONAL_IDM else {}
        started = time.monotonic()
        with torch.inference_mode():
            output = self.model.infer_action(
                prompt="A video recorded from a robot's point of view executing the following instruction: " + task,
                input_image=x, proprio=proprio, action_horizon=HORIZON,
                negative_prompt="", text_cfg_scale=1.0, num_inference_steps=num_inference_steps,
                sigma_shift=sigma, seed=seed, rand_device="cpu", tiled=False,
                compile_action_infer=compile_action_infer, **options,
            )
        action = output["action"].detach().float().cpu().reshape(HORIZON, action_width)
        action = self.normalizer.normalizers["action"]["default"].backward(action).numpy()
        return {"actions": decode_actions(action, self.variant), "inference_s": time.monotonic() - started}


def create(profile, context):
    return FastWam(profile, context)
