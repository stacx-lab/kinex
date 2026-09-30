---
name: rgbd
type: rgbd
description: RGBD camera readings, image geometry, timestamps and runtime conventions.
---

## Use

read returns a color file plus depth_file, dimensions and acquisition sample_time_s/depth_sample_time_s. Color is uint8 RGB PNG; depth is uint16 pgm16_be (P5, maxval 65535), for numerical processing.

Optical axes: X right, Y down, Z forward. Pixel center (0,0) is top-left; u right, v down; outer edges are -0.5 and size-0.5. Mount places the color optical frame in parent_frame. Projection/distortion come from the profile; use kinex.camera helpers. FOV is derived; changed image geometry needs matching calibration.

Depth metres = raw * scale_m_per_unit. quantity:z is optical Z; range is ray length. Reject invalid_value and values outside valid_range_m; reliable_range_m describes quality. registration:color shares the color grid/calibration/frame. registration:native uses depth's projection/distortion and depth_to_color maps depth into color. Never assume depth scale or registration from pixels.

Color/depth timestamps share acquisition Unix seconds; cached frames retain them. Unavailable acquisition times are null with separate received_time_s. Keep paired capture and calibration consistent. fps:null means on-demand. Native recording requires a persistent driver.
