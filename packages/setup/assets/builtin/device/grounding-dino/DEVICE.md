---
name: grounding-dino
type: detection
description: Grounding DINO open-vocabulary object detection, returning text-labeled boxes and scores in the input image.
---

## Setup

The device tool can load/unload this service with device_act permission;
/load and /unload use the same lifecycle. Status/ping never starts a process.
Failed startup releases resources; explicitly load again after a failure.

Provision the public `IDEA-Research/grounding-dino-tiny` checkpoint using the
[Transformers implementation](https://huggingface.co/docs/transformers/v4.57.1/model_doc/grounding-dino).
Choose `cpu` or `cuda:N` from the user's preference and available hardware.
All dependencies, weights, caches and outputs stay inside the device directory.

```sh
bash <instance-dir>/setup.sh --dir .kinex/devices/grounding-dino --compute cuda:0
```

The script installs a private venv and pinned model snapshot, checks imports and
compute availability, and copies the driver. It can be rerun after interruption.
Register the starter profile with `calib_write`, setting
`access.driver.interpreter` to the printed absolute path and
`access.connection.compute` to the selected CPU or CUDA device. Keep `loaded: false`.
Setup does not start the service; `/load grounding-dino`, `/ping grounding-dino`
and `/unload grounding-dino` control its lifecycle.

`detect {image, prompt, min_score?, max_results?}` accepts an
existing image. Separate categories with periods, e.g. `bowl. drawer handle.`.
It returns descending-score `results` with `box: [x1,y1,x2,y2]` in original-image
pixels, `score` and `label`, plus an overlay `file`. No detections means `results: []`.
The persistent driver loads local weights once; `read` and `status` never load them.

The detection type supplies the canonical `detect` contract and defaults
(`min_score: 0.25`, `max_results: 10`). This driver returns boxes without masks;
`locate_object_3d` can use them for a box-region estimate when depth is available.

### Profile

```yaml
name: grounding-dino
type: detection
loaded: false
access:
  source: default
  connection:
    kind: process
    compute: {kind: cuda, index: 0}
  driver:
    entry: driver.py
    actions: [read, load, unload, status, detect]
    persistent: true
    timeout_s: 300
intrinsics:
  source: default
  family: grounding-dino
  variant: tiny
  implementation:
    repository: https://github.com/huggingface/transformers
    revision: v4.57.6
  artifacts:
    - name: checkpoint
      path: weights
      source:
        kind: huggingface
        repo: IDEA-Research/grounding-dino-tiny
        revision: a2bb814dd30d776dcf7e30523b00659f4f141c71
        filename: model.safetensors
```
