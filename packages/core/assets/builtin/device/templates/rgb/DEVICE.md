---
name: rgb
type: rgb
description: Register a RGB camera with a fixed output profile and a source-specific driver.
---

## Use

read returns the color image as file, with width, height and sample_time_s. Output is uint8 RGB PNG in the declared intrinsics.color geometry. The agent sees the image directly; files are available for numerical processing.

Optical axes: X right, Y down, Z forward. Pixel center (0,0) is top-left; u right, v down; outer edges are -0.5 and size-0.5. Mount maps the color optical frame to parent_frame. A wrist camera follows its named parent frame.

Projection is pinhole (fx/fy/cx/cy/skew in pixels); distortion is none or opencv_brown_conrady. Use kinex.camera for geometry. FOV is derived. Changes to focus, crop, resolution or rectification require matching calibration.

sample_time_s is acquisition Unix seconds. Cached frames retain acquisition time. If unavailable it is null with separate received_time_s. fps:null means on-demand capture. Recording streams are managed through record; native capture requires a persistent driver.
