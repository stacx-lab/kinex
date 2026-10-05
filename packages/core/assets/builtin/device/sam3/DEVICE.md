---
name: sam3
type: segmentation
description: SAM3 open-vocabulary segmentation service — text-prompt (detect) and point-prompt (segment_point) masks with boxes/scores; the perception backend for tools like locate_object_3d.
---

## Setup

The device tool can load/unload this service with device_act permission;
/load and /unload use the same lifecycle. Status/ping never starts a process.
Failed startup releases resources; explicitly load again after a failure.

Registration = one interview + one script run + one profile_write. It PROVISIONS
the device and writes its profile with `loaded: false`; it never starts the
service — the user activates it later with `/load sam3` (which serves the
model), checks it with `/ping sam3`, and frees the GPU with `/unload sam3`.

**Containment rule: every asset lands INSIDE the device directory**
(`.kinex/devices/sam3/`): venv, the sam3 checkout, the weight
checkpoint (`weights/sam3.pt`), cache (`hf-cache/`), inference outputs (`out/`). Nothing is written to
`~/.cache` or any global cache; deleting the device directory removes the
install completely.

### 1. Interview

Ask the user (one questionnaire):
- GPU or CPU — and which one: `cuda:0`, `cuda:1`, ... or `cpu` (recorded as
  `access.connection.compute` as `{kind: cuda, index: N}` or `{kind: cpu}`).
- Hugging Face access to `facebook/sam3`? The weights are GATED: an accepted
  access request (https://huggingface.co/facebook/sam3) plus a token — from
  `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`, or a cached `hf auth login`. No
  token → stop and ask them to request access first (the script checks this
  before doing anything slow, but don't waste their time).

### 2. Run the setup script

Everything else is ONE command (this instance directory's `setup.sh`;
idempotent — re-run after a failure and it continues):

    bash <instance-dir>/setup.sh --dir .kinex/devices/sam3 \
        --compute <cuda:N|cpu> [--token hf_...]

It provisions the venv (torch pinned 2.6.0 — the wheel bundles its matching
CUDA/cuDNN), installs SAM3's deps, checks out the pinned fork
(Max-Fu/sam3 @ 6fe87d64, the cap-x / agentic-robotics-bench recipe), installs
it editable in **compat mode**, verifies imports + package assets + the
compute placement, downloads the gated weights into the device-local
`weights/sam3.pt` with a completeness check, and copies `driver.py` in place. Its
final summary prints the two values registration needs.

### 3. Register

Merge the starter profile below via profile_write, filling from the
script's summary:
- `access.driver.interpreter`: `<device-dir>/venv/bin/python` (absolute)
- `access.connection.compute`: `{kind: cuda, index: N}` or `{kind: cpu}`
- keep `loaded: false` — do not flip it yourself

### 4. Verify (static only)

Validate the profile, imports and driver syntax. The readiness section in current context should show the
connection, declared actions and intrinsics complete once registration is done;
Use /ping for current service liveness.
Tell the user: `/load sam3` initializes the model, `/ping sam3` probes readiness,
and `/unload sam3` releases it. Validate one real segmentation after loading.

### Troubleshooting reference

- **`TypeError: expected str, bytes or os.PathLike object, not NoneType`
  during weight load**: the editable install used setuptools' strict mode,
  which exposes `sam3` as a namespace package with `__file__ = None`; the
  model builder resolves its BPE vocab (`assets/bpe_simple_vocab_16e6.txt.gz`)
  relative to `__file__`. Reinstall with
  `pip install --no-deps -e <dir>/sam3 --config-settings editable_mode=compat`
  (setup.sh does this and verifies the asset path).
- **cuDNN version/symbol errors at torch import**: a system CUDA/cuDNN on
  `LD_LIBRARY_PATH` is shadowing the wheel's bundled one — unset it; never
  install cudnn separately.
- **Weight cache has only LICENSE/README**: the token's account lacks an
  accepted access request for the gated repo.

### Serving contract (what the driver implements)

`read` → readiness without loading; `load` → the /load hook (ensures weights are loaded);
`unload` → the /unload hook (frees the GPU); `status` → the /ping probe (status facts, never inference);
`detect {image, prompt, min_score?, max_results?}` → boxes/scores/labels inline + mask
PNGs and an overlay grid under `out/`, overlay returned as `file`;
`segment_point {image, point}` likewise. Persistent (`--serve`): weights load
once on load, on the profile's `access.connection.compute`.
The segmentation type supplies detect and its defaults (min_score 0.25, max_results 10);
segment_point remains an additional declared operation.
The driver explicitly opens the checkpoint artifact path with remote loading
disabled. The segmentation Use guide from the core Device guide roots applies
to this instance.

### Profile

```yaml
name: sam3
type: segmentation
loaded: false
access:
  source: default
  connection:
    kind: process
    compute: {kind: cuda, index: 0}
  driver:
    entry: driver.py
    actions: [read, load, unload, status, detect, segment_point]
    persistent: true
    timeout_s: 300
intrinsics:
  source: default
  family: sam3
  variant: image
  implementation:
    repository: https://github.com/Max-Fu/sam3.git
    revision: 6fe87d64a5beb9084923d7a9e002741178635b09
  artifacts:
    - name: checkpoint
      path: weights/sam3.pt
      source:
        kind: huggingface
        repo: facebook/sam3
        revision: main
        filename: sam3.pt
  operations:
    - name: segment_point
      input:
        type: object
        required: [image, point]
        properties:
          image: {type: string, format: path}
          point: {type: array, items: {type: number, minimum: 0}, minItems: 2, maxItems: 2}
          max_results: {type: integer, minimum: 1, default: 3}
      output:
        type: object
        required: [results]
        properties:
          file: {type: string, format: path}
          results:
            type: array
            items:
              type: object
              required: [box, score, label, mask]
              properties:
                box: {type: array, items: {type: number}, minItems: 4, maxItems: 4}
                score: {type: number, minimum: 0, maximum: 1}
                label: {type: string}
                mask: {type: string, format: path}
```
