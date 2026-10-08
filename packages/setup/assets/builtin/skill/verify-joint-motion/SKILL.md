---
name: verify-joint-motion
description: Measure small gated joint motions, stop and hold behavior when the current task needs motion evidence for a joint device.
---

# Verify joint motion

Bind `arm` to the joint device whose interface is already verified. Declare
only the selected joint and checks as plan inputs; unused joints are not
prerequisites. Choose the amplitude, the tolerances and the joint before any
trial; do not sweep every joint by default.

Require responsive measured feedback (fresh timestamps, empty faults) before
physical preparation. A powered trial requires clear surroundings, payload
removed, an operator at the e-stop, one joint at a time, and observation for
self-collision. Read the full joint position vector immediately before each
trial. Change only the selected joint by the agreed amplitude, at most 0.05 rad
(or 0.05 m for a prismatic joint), within its declared limits. Submit that
absolute vector through permission-checked `servo` with `speedFraction:0.05`.
Never move the robot through scripts, `check.sh` or ROS command-line tools.
Device writes return immediately. Use `world.wait` when a world clock is loaded;
on physical hardware, poll fresh feedback through `calib_sample` with settle.
Check the measured position against the target; elapsed time or a quiet sample
alone does not establish arrival.
Stop immediately on fault, no progress, unexpected movement or operator
interruption, and preserve the stopped position and reason as partial evidence.

Trials, each archived with its command, timestamps and readings:

- `arrival:<joint>`: command one small step on the selected joint; expected is
  the commanded position, measured is the settled position, units rad (or m)
  with an explicit tolerance.
- `hold_after_stop`: command a second small step and issue one `device_stop`
  mid-motion; then sample over at least 1 s and report the position drift
  after the stop, units rad (or m) with a tolerance, against the declared stop
  behavior (hold or halt).
- `velocity_quiet`: the largest measured joint speed over that post-stop window,
  units rad/s with a tolerance, from the device's own velocity feedback.

Summarize only the selected checks into the format described by `calib_compute`
and run `operation:verify-checks`. Numerical checks require explicit units and
tolerance; missing references remain partial. Repeat only failed or
underdetermined checks. Fix proven conversion errors by rerunning a bundle's
`setup.sh` or, for a template driver, in `driver.py`; reload and retest that
check. Do not tune the controller, change controller gains or infer safe limits
from a handful of trials. Record only the resolved plan node with the numbered
result evidence and resume the task.

See [procedure.json](procedure.json) for roles and computations.
