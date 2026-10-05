---
name: detection
type: detection
description: Image object detector with a standard text-prompt interface and optional masks.
---

## Setup

Use setup-device to provision a local runtime or remote service. Follow the
model type's provisioning conventions: record identity, implementation, local
artifacts, connection and driver interpreter; keep loaded: false. Match a
concrete instance guide first. The model driver skeleton supplies lifecycle;
implement its SDK hooks for detect using the Use contract below.

Core supplies detect in intrinsics.operations; do not redefine it. Add only
additional operations there and declare them in access.driver.actions.
Weights must exist locally before activation; runtime must not download them.
Undo model resizing/cropping in returned boxes and masks; preserve original-image
coordinates and scores in [0,1]. Process only the supplied image, never a fresh
camera capture.

### Profile

```yaml
name: detection
type: detection
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
`detect({image, prompt, min_score?, max_results?})` uses the supplied image;
defaults are 0.25 and 10. Results are sorted by score and contain pixel box
[x1,y1,x2,y2], score and label. Optional masks are single-channel PNGs aligned to
the original image, with nonzero foreground; `file` may contain an overlay.
No detections returns `results: []`.

`locate_object_3d` uses a supplied mask, otherwise the box center region, to
estimate a camera-relative point. Use `relative_pose` for frame conversion.
