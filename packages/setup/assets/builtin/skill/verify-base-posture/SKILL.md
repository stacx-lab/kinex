---
name: verify-base-posture
description: Verify selected height or attitude references and moving attachment frames for a base that exposes posture control.
---

# Verify base posture

Declare only the selected mode and measured channels as plan inputs; unused modes
and feedback channels are not prerequisites.

Bind `base` to its velocity endpoint and inspect the selected mode's posture
components and reference. Support only exposed height/roll/pitch/yaw axes. Torso
yaw posture is distinct from base turning velocity. Use a documented reference
and independent measurements where needed to establish physical zero or units.

Select a task-relevant posture check; do not explore the full posture range.
Use documented or explicitly supplied amplitudes and tolerances. Prepare a clear
stable area and agreed arm configuration. Maintain balance with the existing
controller and declared stand/stop behavior. Verify live feedback before commanding.

Command one supported posture change, wait in world time, and collect fresh
measurements. Inspect moving attachment frames used by the arm or cameras; their
poses must follow the body/torso relationship. When the selected task depends on
retention, verify that velocity expiry or stop retains the declared posture.
Zero velocity and a submitted command do not prove stationarity or achieved posture.
Stop on faults, unexpected movement or operator interruption.

Archive samples, independent references and selected acceptance criteria, then run
calib_compute operation:verify-base using its documented measurement format.
Report missing measurements as partial. Persist only verified reference/default
facts; correct proven driver conversion errors through setup-device and reload.
Do not infer safe limits from a handful of successful trials or tune the gait.
Return to the task once its selected requirements are met.

See [procedure.json](procedure.json) for roles and computations.
