---
name: verify-base-motion
description: Measure selected base motion, expiry or stopping behavior when the current task needs evidence about those operations.
---

# Verify base motion

Declare only the selected mode and measured channels as plan inputs; unused modes
and feedback channels are not prerequisites.

Bind `base` to the selected velocity endpoint. Use its declared mode, supported
axes, command units, measured feedback and stop scope. Choose the missing fact
and its acceptance criteria before trials; do not run a full axis sweep by default.

Use documented or explicitly supplied trial amplitudes, durations and tolerances.
Require a clear trial area and an available stop path. Keep the arm in the agreed
configuration and preserve the base controller's balance/posture behavior. Start
with one selected axis/direction. Device writes return immediately; use world.wait
and fresh timestamped readings to measure the interval. Stop on faults, unexpected
movement or operator interruption. Command expiry is not measured stopping.

Use independent displacement/heading or velocity reference measurements when
verifying feedback accuracy. Self-reported feedback can characterize command
tracking but cannot independently certify localization. In particular, normalized
commands remain normalized; do not label command-to-measured differences as SI
tracking error. Separate localization, tracking, expiry, and stopping checks.

Record evidence using calib_sample and archive command/observation/reference
associations. Summarize only selected measurements into the format described by
calib_compute and run operation:verify-base. Numerical checks require explicit
units and tolerance; insufficient references remain needs-input or partial.

Record trial conditions and coverage. Repeat only failed or underdetermined checks.
Correct verified driver conversion errors if needed, then reload and retest that
check. Do not optimize odometry, wheel geometry or gait control. Once the current
task's required fact is established, resume the task.

See [procedure.json](procedure.json) for roles and computations.
