---
name: calibrate-joint-range
description: Resolve joint limits from models or referenced measurements only when required; world geometry is separate.
---

# Calibrate joint range

Bind `arm` to the joint device or dexterous hand. Prefer its device-owned URDF,
explicit joint model or vendor metadata. `calib_compute operation:urdf-introspect`
resolves the selected URDF offline; no device activation is needed. Preserve the
model reference. Home is a separate named configuration, never inferred from URDF.

`scripts/estimate_reach.py` optionally samples FK reach in the device base frame.
This is analysis without collision checking; do not persist it as world bounds.

Measure limits only when the task needs missing or explicitly requested measured
limits. Require responsive measured feedback before physical preparation. Prefer
operator hand-guiding with stationary `calib_sample` readings. A powered sweep
requires clear surroundings, payload removed, an operator at the e-stop, one joint
at a time, and observation for self-collision. Use small type-appropriate increments
(2–5 degrees in radians for revolute joints, small metre increments for prismatic
joints) with `servo speedFraction:0.05`. Wait and verify arrival after each step.
Stop immediately on fault, no progress, near-stop report or operator interruption;
do not probe a hard stop. Preserve the stopped position/reason as partial evidence.

Persist verified limits in the device-owned model, retaining geometry and IK.
Do not create duplicate joints/DOF fields in the profile. Record home only from
an independently established configuration. Changing a model invalidates dependent
results; re-evaluate only the current task's affected branch.
For model-free measurement, first prepare an explicit joint inventory with the
correct joint order; never invent a joint set from unlabelled readings.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.
