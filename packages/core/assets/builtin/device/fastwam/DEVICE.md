---
name: fastwam
type: model
description: FastWAM action inference for LIBERO and RoboTwin, including LIBERO Optional IDM. Returns predictions; run_policy owns IK and robot execution.
---

## Setup

Provision with `bash <builtin-dir>/setup.sh --dir .kinex/devices/fastwam
--compute cuda:0`. `--source /path/to/FastWAM` can reuse a local Git source;
the device still receives its own checkout at the pinned revision.
All downloads, Python dependencies and caches stay inside the instance directory.
Allow about 50 GB for model artifacts plus environment/cache space. CUDA is required.

The script emits `profile.generated.json`; register its contents using
`profile_write`, leaving `loaded: false`. `/load fastwam` initializes the selected
variant, `/ping fastwam` reports readiness, `/unload fastwam` releases GPU memory.
Discovery and status do not load weights. Runtime is offline; rerun setup to repair
missing/corrupted artifacts. No training datasets, simulator packages or training
dependencies are required. The environment is separate from `.kinex/python`.

Variants: `libero_uncond_2cam224` (default), `libero_optional_idm_2cam224`,
`robotwin_uncond_3cam_384`. To change variant, unload, generate a new candidate
with `venv/bin/python provision.py --variant VARIANT --compute cuda:0`, apply
the updated profile through calibration, and load explicitly. All three checkpoints
share one provisioned instance; only the selected variant is resident.

## Inference

`infer {obs: {images: [paths...], state: [numbers...]}, task: "instruction"}`
returns `actions` (32 rows) and `inference_s`. Options: `seed` (default 0),
`num_inference_steps` (10), `compile_action_infer` (false). Optional IDM also
accepts `action_infer_mode: first_frame|idm` (default first_frame). IDM imagines
future latents but does not decode or return videos. The original checkpoints use
scheduler shift 5; Optional IDM uses 1. Inference uses BF16.

LIBERO: two images in agent-view/wrist order, already oriented as upstream
evaluation expects; the driver crops/resizes each to 224 square and concatenates
horizontally. State is world grip-site xyz, world flange-body axis-angle, then
two measured finger coordinates. Note that position and orientation use different
native frames. Output rows contain world translation deltas (metres), world
axis-angle rotation deltas (radians), and gripper direction (-1 open, +1 close).
The driver applies upstream action denormalization, OSC clipping/scales and
gripper sign/binarization; do not apply these twice.

RoboTwin: head/left-wrist/right-wrist images, packed into a 384×320 composite;
state and actions use upstream's 14-value order: left arm six joints, left
gripper, right arm six joints, right gripper. Gripper values retain the upstream
coordinate convention; map them only to devices declaring matching semantics.

## Execution

Pass the observation to `run_policy`. For the LIBERO Panda workspace:

```json
{
  "model": "fastwam",
  "observation": {"images": ["agent.png", "wrist.png"], "state": [0,0,0,0,0,0,0,0]},
  "task": "open the top drawer of the cabinet and put the bowl in it",
  "command": [
    {"device": "arm", "space": "pose_delta", "frame": "world", "target_frame": "gripper:tcp"},
    {"device": "gripper"}
  ],
  "action_hz": 20,
  "max_actions": 10
}
```

Here `max_actions: 10` executes at most the first 10 predictions at 20 Hz,
giving a 0.5-second execution horizon. Use `track` with fresh observations and
`wait_s: 0.5` to infer a new chunk after each window; unused predictions are
discarded. IK rejection may shorten the executed prefix further.

Replace the example images/state with actual observations. A workspace perception
tool must obtain them through available measurements and declared frames.
The generic gripper read exposes aperture only; it cannot supply the two native
finger coordinates this checkpoint requires. Use a model-specific observation
adapter that supplies those measurements; do not invent them from aperture.
RoboEnv LIBERO PNGs
are vertically corrected already: horizontally flip them to match FastWAM's
180-degree rotation of raw OpenGL images. Do not rotate the corrected PNGs twice.

`run_policy` converts Cartesian actions through seeded IK before submitting
absolute joint buffers. On IK failure, it submits the shared valid
prefix for arm and gripper at the same action rate and returns `ik_failure` with
the device, zero-based action index and error. IK rejection returns normally so
`track` can continue; an empty prefix leaves existing buffers intact.
This differs from upstream OSC feedback;
successful chunk execution does not establish benchmark task success.
`inference_args` forwards additional model options, e.g. Optional IDM's mode.

Source: https://github.com/yuantianyuan01/FastWAM (MIT; license retained in checkout).
Checkpoints: https://huggingface.co/yuanty/fastwam. Exact revisions, sizes and
content hashes are in `artifacts.json`.
