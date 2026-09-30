---
name: detection
type: detection
description: Image object detector with a standard text-prompt interface and optional masks.
---

## Use

An inference service, with no physical pose. read/status report readiness;
`load` initializes it and `unload` releases its resources; both are available
through the device tool with device_act permission or /load and /unload.

detect {image, prompt, min_score?, max_results?} returns results sorted by
descending score. Defaults: min_score 0.25, max_results 10. Each result has
box [x1,y1,x2,y2] in original-image pixels, score in [0,1], and label.
An optional mask is a single-channel PNG, nonzero foreground, aligned to the
input image. An optional top-level file is an overlay. No detections: results [].
Drivers undo resizing/cropping and never capture another camera frame.

locate_object_3d uses supplied masks exclusively; without a mask it estimates
from the box's central region, which may contain background. It returns a
camera-relative point. Supply an orientation to form a full local pose before
converting it with relative_pose.
The resolved intrinsics.operations contains the canonical detect contract and
any additional declared operations. The harness validates inputs and outputs.
