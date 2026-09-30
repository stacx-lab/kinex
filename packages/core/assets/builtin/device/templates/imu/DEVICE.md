---
name: imu
type: imu
description: Inertial measurements with explicit acceleration quantity, measured axes, optional orientation reference and magnetic field. Fixed profile and read-only driver.
---

## Use

read returns angular_velocity (rad/s), linear_acceleration (m/s²), magnetic_field (T), and orientation. Vectors are maps containing the declared axes; unsupported channels are null. orientation is unit xyzw, placing the measurement frame in its declared reference.

All vectors use the measurement frame placed by mount; acceleration is measured at its origin. Rotating coordinates does not relocate that measurement: moving the origin requires rotational-motion terms. Harness readings already subtract profile bias once; never subtract it again.

Acceleration quantity:specific_force is a-g: zero in freefall, opposite gravity at rest (+9.81 Z only if +Z points up). gravity_removed is motion acceleration, near zero at rest. Never silently remove gravity or treat it as bias.

Orientation reference: frame uses the actual named frame; startup is relative to the startup epoch, not absolute world. gravity_aligned has +Z up: relative heading uses initial horizontal +X, while magnetic_north/true_north use ENU (+X east,+Y north). Different startup epochs are not comparable. No implicit zeroing/reference reset occurs on load/read.

sample_time_s is acquisition time when available, not polling time; sample_rate_hz is descriptive. Use kinex.imu.read for corrected readings. Fusion/integration are explicit tools. This device is read-only and needs no world.
