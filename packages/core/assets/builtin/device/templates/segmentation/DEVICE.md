---
name: segmentation
type: segmentation
description: Image object detector that supplies a foreground mask for every detection.
---

## Setup

Use setup-device and the model provisioning conventions: record identity,
implementation, local artifacts, connection and driver interpreter; keep
loaded: false. Match a concrete instance guide first. Implement the model
driver skeleton's SDK hooks, returning a real foreground mask for each result.

Core supplies the mask-required detect contract in intrinsics.operations;
do not redefine it. Declare extra operations, such as point segmentation,
with their input/output contracts and include them in access.driver.actions.
Weights must exist locally before activation; runtime must not download them.
Undo model resizing/cropping in returned boxes and masks; preserve original-image
coordinates and scores in [0,1]. Process only the supplied image, never a fresh
camera capture.

### Profile

```yaml
name: segmentation
type: segmentation
loaded: false
access:
  connection: {kind: process, compute: "???"}
  driver:
    entry: driver.py
    persistent: true
    actions: [read, load, unload, status, detect]
    timeout_s: 300
intrinsics:
  family: "???"
  artifacts: "???"
```

## Use

Inference service with no physical frame; read/status report readiness.
`detect({image, prompt, min_score?, max_results?})` defaults to 0.25 and 10.
Results are sorted by score, each with pixel box [x1,y1,x2,y2], score, label
and a required mask PNG path. Masks are single-channel, nonzero foreground and
aligned to the supplied image. `file` may contain an overlay; no matches returns
`results: []`.

Segmentation satisfies detection requirements. `locate_object_3d` samples depth
only inside the mask and fails on unusable depth; use `relative_pose` for frame
conversion.
