---
name: force_torque
type: force_torque
description: Force-only, torque-only or combined load measurements with explicit quantity, target, axes and reference frame. Optional for task readiness.
---

## Use

read returns force and torque as measured x/y/z axis maps, or null when unsupported. Units: N and N·m. The profile declares axes; unknown axes are never zero-filled. measurement.quantity distinguishes transmitted connection load, external load, contact_normal, contact_total (including tangential), and actuation load. measurement.target identifies the body/frame receiving positive load.

Vectors use the measurement frame placed by mount. Positive force follows its axes; torque is right-handed about its origin. Target and mount may differ. Neither requires world. Translating a torque origin requires force as well as torque; kinex.force_torque helpers require full axes for general transforms.

Harness readings already have profile bias subtracted once: do not subtract it again or tare away real gravity/contact loads. Numeric zero is a measurement; null is unsupported. range is a rating, not a clamp or motion limit. sample_rate_hz is descriptive, not a pacing command. sample_time_s is acquisition time when available; polling time is not acquisition time. No automatic tare occurs on load/read. This device is read-only and optional for task readiness.
