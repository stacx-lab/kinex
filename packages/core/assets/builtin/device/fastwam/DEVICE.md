---
name: fastwam
type: model
description: FastWAM action inference for LIBERO and RoboTwin, including LIBERO Optional IDM. Returns predictions; run_policy owns IK and robot execution.
---

## Setup

Read the model type guide (`templates/model/DEVICE.md` in the device guide roots)
first: it defines `compute`, artifacts and the load/unload contract this bundle
follows. FastWAM needs CUDA. Provision one variant:

```sh
setup.sh --dir .kinex/devices/fastwam --python KINEX_PYTHON --compute cuda:0 --variant libero_uncond_2cam224
```

It installs the pinned dependencies into the device's `site/`, checks out the
pinned FastWAM source into `source/`, verifies the compute device, and downloads
about 26 GB into `weights/`: the variant's checkpoint and dataset statistics plus
the shared Wan2.2 VAE, UMT5 encoder and tokenizer. It then copies `node.py` and
`env.sh`; the overlay exposes the packages and source to this node only and keeps
Hugging Face offline, so load never downloads.

| Variant | Cameras | State | Action |
| --- | --- | --- | --- |
| `libero_uncond_2cam224` | 2 | 8 | 7 |
| `libero_optional_idm_2cam224` | 2 | 8 | 7 |
| `robotwin_uncond_3cam_384` | 3 | 14 | 14 |

Write the profile below with the provisioned `variant` and `compute`. For another
variant, replace the `checkpoint` and `dataset_stats` artifacts with that
variant's `yuanty/fastwam` files. Validate, then load.

### Operations

- `infer`: `kinex_interfaces/srv/Json` taking `obs` `{images, state}`, `task` and
  optional `seed` (0), `num_inference_steps` (10) and `compile_action_infer`
  (false); Optional IDM also takes `action_infer_mode` (`first_frame` or `idm`).
  `images` are the variant's camera image paths in the evaluator's orientation
  and `state` its proprioception. It returns `inference_s` and 32 `actions`. LIBERO
  actions are deltas of ±0.05 m translation and ±0.5 rad rotation followed by the
  gripper command −1 (open) or +1 (close).

### Profile

```yaml
name: fastwam
type: model
loaded: false
description: FastWAM world-action model predicting 32-step action chunks from camera images, proprioception and a task instruction. Predictions are not executed; validate them before control.
runtime:
  overlays: [env.sh]
  nodes: [{entry: node.py, factory: create}]
  ready_timeout_s: 600
operations:
  infer:
    description: "Predict an action chunk. Input {obs: {images: camera image paths in the evaluator's orientation, state: proprioception}, task: instruction, seed: default 0, num_inference_steps: default 10, compile_action_infer: default false}. Output {actions: 32 rows of 7 LIBERO actions (xyz deltas within ±0.05 m, rotation deltas within ±0.5 rad, gripper -1 open or +1 close), inference_s}."
    transport: service
    direction: input
    endpoint: /kinex/fastwam/infer
    type: kinex_interfaces/srv/Json
    timeout_s: 120
family: fastwam
variant: libero_uncond_2cam224
implementation: {repository: "https://github.com/yuantianyuan01/FastWAM", revision: 7faa71108368fbb3b6885649f112af607427a2d4}
artifacts:
  - {name: checkpoint, path: weights/yuanty/fastwam/libero_uncond_2cam224.pt, source: {kind: huggingface, repo: yuanty/fastwam, revision: 8eaceeb24c3cc92ff2a9c9a9d266a4941b836705, filename: libero_uncond_2cam224.pt}}
  - {name: dataset_stats, path: weights/yuanty/fastwam/libero_uncond_2cam224_dataset_stats.json, source: {kind: huggingface, repo: yuanty/fastwam, revision: 8eaceeb24c3cc92ff2a9c9a9d266a4941b836705, filename: libero_uncond_2cam224_dataset_stats.json}}
  - {name: vae, path: weights/Wan-AI/Wan2.2-TI2V-5B/Wan2.2_VAE.pth, source: {kind: huggingface, repo: Wan-AI/Wan2.2-TI2V-5B, revision: 921dbaf3f1674a56f47e83fb80a34bac8a8f203e, filename: Wan2.2_VAE.pth}}
  - {name: text_encoder, path: weights/Wan-AI/Wan2.2-TI2V-5B/models_t5_umt5-xxl-enc-bf16.pth, source: {kind: huggingface, repo: Wan-AI/Wan2.2-TI2V-5B, revision: 921dbaf3f1674a56f47e83fb80a34bac8a8f203e, filename: models_t5_umt5-xxl-enc-bf16.pth}}
  - {name: tokenizer, path: weights/Wan-AI/Wan2.1-T2V-1.3B/google/umt5-xxl/tokenizer.json, source: {kind: huggingface, repo: Wan-AI/Wan2.1-T2V-1.3B, revision: 37ec512624d61f7aa208f7ea8140a131f93afc9a, filename: google/umt5-xxl/tokenizer.json}}
  - {name: tokenizer_config, path: weights/Wan-AI/Wan2.1-T2V-1.3B/google/umt5-xxl/tokenizer_config.json, source: {kind: huggingface, repo: Wan-AI/Wan2.1-T2V-1.3B, revision: 37ec512624d61f7aa208f7ea8140a131f93afc9a, filename: google/umt5-xxl/tokenizer_config.json}}
  - {name: special_tokens_map, path: weights/Wan-AI/Wan2.1-T2V-1.3B/google/umt5-xxl/special_tokens_map.json, source: {kind: huggingface, repo: Wan-AI/Wan2.1-T2V-1.3B, revision: 37ec512624d61f7aa208f7ea8140a131f93afc9a, filename: google/umt5-xxl/special_tokens_map.json}}
  - {name: spiece, path: weights/Wan-AI/Wan2.1-T2V-1.3B/google/umt5-xxl/spiece.model, source: {kind: huggingface, repo: Wan-AI/Wan2.1-T2V-1.3B, revision: 37ec512624d61f7aa208f7ea8140a131f93afc9a, filename: google/umt5-xxl/spiece.model}}
compute: ???
```
