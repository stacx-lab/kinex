---
name: calibrate-sensor-bias
description: Measure IMU gyro/accelerometer or force/torque bias from static, unloaded readings when a task needs bias-corrected measurements.
---

# Calibrate sensor bias

Bind `target` to the imu or force_torque device. Its node subtracts the profile
`bias` from every reading, so a channel must hold a recorded bias, zeros until
calibrated, before the device can load. Prefer a factory or vendor-tool bias that
matches the active configuration; archive its source instead of measuring.

Measure in a known static state. An IMU must not move or vibrate; a force/torque
sensor carries no load beyond its declared target and makes no contact. Hold that
state for the whole collection and confirm it with the operator, since `settle`
has no velocity feedback for these devices. Let the sensor reach its operating
temperature first; bias drifts with temperature.

Load the device and collect at least 20 readings with `calib_sample` into one
attempt, reusing its run ID. Then run `calib_compute operation:sensor-bias` with
`samples` set to the attempt's `samples.json`. A `specific_force` accelerometer
reads gravity at rest: pass `gravity_m_s2`, the expected reading in the IMU frame
from an independently established orientation, for example `[0, 0, 9.80665]` when
level with +z up. `gravity_removed` accelerometers, gyros and wrench channels
expect zero. Magnetometer bias needs rotation through many orientations and is
out of scope.

The result proposes the current bias plus each axis's mean residual. Review the
per-axis standard deviation: a spread comparable to the residual means the state
was not static or the sensor is noisy. Apply accepted `bias` fields with
`profile_write`, then unload and reload the device so its node uses them, and
confirm that fresh static readings average near the expected values.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.
