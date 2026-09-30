---
name: segmentation
type: segmentation
description: Image object detector that supplies a foreground mask for every detection.
---

## Use

An inference service, with no physical pose. read/status report readiness;
`load` initializes it and `unload` releases its resources; both are available
through the device tool with device_act permission or /load and /unload.

detect {image, prompt, min_score?, max_results?} shares the detection interface,
with a required mask for every result. Defaults: min_score 0.25, max_results 10.
Return results sorted by descending score, each with box [x1,y1,x2,y2] in
original-image pixels, score in [0,1], label, and mask PNG path. Masks are
single-channel, nonzero foreground, and match the input image's dimensions and
coordinates. Drivers undo resizing/cropping and never capture another frame.
An optional top-level file is an overlay. No detections: results [].

Segmentation satisfies detection requirements. locate_object_3d samples depth
only inside the supplied mask and fails on unusable masks or depth holes;
it never widens sampling to the box. Frame conversion belongs to relative_pose.
The resolved intrinsics.operations exposes detect and any additional operations.
