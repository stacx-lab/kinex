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

Load the device, collect at least 20 readings with `run.sample` in one run, and
solve with `lib.calibration.sensor.bias`. A `specific_force` accelerometer reads
gravity at rest: take `gravity_m_s2` from an independently established orientation.
Magnetometer bias needs rotation through many orientations and is out of scope.

Review the per-axis standard deviation against the residual. Apply accepted `bias`
fields with `profile_write`, then unload and reload the device so its node uses
them, and confirm that fresh static readings average near the expected values.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.
