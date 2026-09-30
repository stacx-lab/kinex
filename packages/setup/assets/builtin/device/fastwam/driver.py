#!/usr/bin/env python3
"""Inference-only FastWAM service. Robot observations and motion stay in tools."""

import contextlib
import gc
import json
import os
from pathlib import Path
import sys
import threading
import time

from kinex.driver_protocol import run, check_cancelled
from fastwam_config import VARIANTS

HERE = Path(__file__).resolve().parent
MODEL = None
NORMALIZER = None
VARIANT = None
LOCK = threading.RLock()


def settings():
    import yaml
    return yaml.safe_load((HERE / "profile.yaml").read_text())


def local_environment():
    for key, value in {
        "HF_HOME": HERE / "cache/huggingface", "XDG_CACHE_HOME": HERE / "cache",
        "TORCH_HOME": HERE / "cache/torch", "TORCHINDUCTOR_CACHE_DIR": HERE / "cache/inductor",
        "TRITON_CACHE_DIR": HERE / "cache/triton", "DIFFSYNTH_MODEL_BASE_PATH": HERE / "weights",
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "DIFFSYNTH_SKIP_DOWNLOAD": "true",
    }.items():
        os.environ[key] = str(value)
    source = str(HERE / "source/src")
    if source not in sys.path:
        sys.path.insert(0, source)


def configuration(variant):
    from omegaconf import OmegaConf
    data, model, *_ = VARIANTS[variant]
    root = OmegaConf.create({
        "data": OmegaConf.load(HERE / "source/configs/data" / f"{data}.yaml"),
        "model": OmegaConf.load(HERE / "source/configs/model" / f"{model}.yaml"),
    })
    return OmegaConf.to_container(root, resolve=True)


def create_model(config, variant, compute):
    import torch
    from fastwam.models.wan22.fastwam import FastWAM
    from fastwam.models.wan22.fastwam_optional_idm import FastWAMOptionalIDM

    optional = variant == "libero_optional_idm_2cam224"
    model_class = FastWAMOptionalIDM if optional else FastWAM
    extra = {"action_idm_prob": config["action_idm_prob"], "video_cond_noise_prob": config["video_cond_noise_prob"]} if optional else {}
    return model_class.from_wan22_pretrained(
        device=compute, torch_dtype=torch.bfloat16,
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


def load(_args):
    global MODEL, NORMALIZER, VARIANT
    with LOCK:
        if MODEL is not None:
            return status({})
        profile = settings()
        variant = profile["intrinsics"]["variant"]
        if variant not in VARIANTS:
            raise ValueError(f"Unsupported FastWAM variant: {variant}")
        connection = profile["access"]["connection"]
        if connection["kind"] != "process" or connection["compute"]["kind"] != "cuda":
            raise ValueError("FastWAM requires a CUDA process connection")
        # Fail before allocating memory; activation never downloads artifacts.
        for artifact in json.loads((HERE / "artifacts.json").read_text()):
            path = HERE / "weights" / artifact["repo"] / artifact["filename"]
            if not path.is_file() or path.stat().st_size != artifact["size"]:
                raise FileNotFoundError(f"Artifact not provisioned: {path}; rerun setup.sh")
        local_environment()
        import torch
        from fastwam.datasets.lerobot.utils.normalizer import LinearNormalizer, load_dataset_stats_from_json

        torch.cuda.set_device(connection["compute"]["index"])
        compute = f"cuda:{connection['compute']['index']}"
        config = configuration(variant)
        model = create_model(config["model"], variant, compute)
        checkpoint = HERE / "weights/yuanty/fastwam" / f"{variant}.pt"
        # Upstream's loader tolerates missing trained weights. Deployment must not.
        payload = torch.load(checkpoint, map_location="cpu", weights_only=True)
        model.mot.load_state_dict(payload["mot"], strict=True)
        model.proprio_encoder.load_state_dict(payload["proprio_encoder"], strict=True)
        del payload
        processor = config["data"]["train"]["processor"]
        normalizer = LinearNormalizer(
            shape_meta=processor["shape_meta"], use_stepwise_action_norm=False,
            default_mode=processor["norm_default_mode"], exception_mode=processor["norm_exception_mode"],
            stats=load_dataset_stats_from_json(str(checkpoint.with_name(f"{variant}_dataset_stats.json"))),
        )
        check_cancelled()
        MODEL, NORMALIZER, VARIANT = model.eval(), normalizer, variant
        return status({})


def status(_args):
    return {"loaded": MODEL is not None, "variant": VARIANT}


def unload(_args):
    global MODEL, NORMALIZER, VARIANT
    with LOCK:
        MODEL, NORMALIZER, VARIANT = None, None, None
        gc.collect()
        if "torch" in sys.modules:
            sys.modules["torch"].cuda.empty_cache()
        return {"unloaded": True}


def image_array(paths, variant):
    """Input paths already use the evaluator's orientation; only resize and pack."""
    import numpy as np
    from PIL import Image

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
    import numpy as np
    actions = np.asarray(actions, dtype=np.float32).copy()
    if not np.isfinite(actions).all():
        raise ValueError("FastWAM returned nonfinite actions")
    if variant.startswith("libero_"):
        actions[:, :6] = np.clip(actions[:, :6], -1, 1) * [0.05, 0.05, 0.05, 0.5, 0.5, 0.5]
        actions[:, -1] = np.sign(1 - 2 * actions[:, -1])
    return actions.tolist()


def infer(args):
    with LOCK:
        if MODEL is None:
            raise RuntimeError("FastWAM is not loaded; explicitly load the device first")
        import torch
        from kinex.validation import vector

        obs = args["obs"]
        _, _, cameras, state_width, action_width, sigma = VARIANTS[VARIANT]
        if len(obs["images"]) != cameras:
            raise ValueError(f"Expected {cameras} camera paths")
        state = vector(obs["state"], state_width, "proprioception")
        pixels = image_array(obs["images"], VARIANT)
        x = torch.from_numpy(pixels.copy()).permute(2, 0, 1).unsqueeze(0).to(MODEL.device, MODEL.torch_dtype)
        x = x * (2.0 / 255.0) - 1.0
        proprio = NORMALIZER.normalizers["state"]["default"].forward(torch.tensor([state], dtype=torch.float32))
        options = {}
        if VARIANT == "libero_optional_idm_2cam224":
            options = {"action_infer_mode": args.get("action_infer_mode", "first_frame"), "num_video_frames": 9}
        check_cancelled()
        started = time.monotonic()
        with torch.inference_mode():
            output = MODEL.infer_action(
                prompt="A video recorded from a robot's point of view executing the following instruction: " + args["task"],
                input_image=x, proprio=proprio, action_horizon=32,
                negative_prompt="", text_cfg_scale=1.0, num_inference_steps=args.get("num_inference_steps", 10),
                sigma_shift=sigma, seed=args.get("seed", 0), rand_device="cpu", tiled=False,
                compile_action_infer=args.get("compile_action_infer", False), **options,
            )
        check_cancelled()
        action = output["action"].detach().float().cpu().reshape(32, action_width)
        action = NORMALIZER.normalizers["action"]["default"].backward(action).numpy()
        return {"actions": decode_actions(action, VARIANT), "inference_s": time.monotonic() - started}


def handle(action, args):
    handlers = {"load": load, "unload": unload, "read": status, "status": status, "infer": infer}
    try:
        if action not in handlers:
            raise ValueError(f"Unknown FastWAM action: {action}")
        with contextlib.redirect_stdout(sys.stderr):
            return {"ok": True, **handlers[action](args)}
    except Exception as error:
        if action == "load":
            unload({})
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}


if __name__ == "__main__":
    run(handle, lambda: unload({}))
