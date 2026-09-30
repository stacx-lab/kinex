---
name: velocity
type: velocity
description: velocity control and observation contract.
---

## Use

`write({mode, velocity?, posture?, duration_s})` submits a velocity/posture
command and returns immediately. Axes, units and frames come from `control.modes`.
At duration expiry, velocity becomes zero while posture is retained.
New valid writes replace pending actions without stopping. Results contain
`execution_id`, actual `elapsed_s` and measured `state`.
Use `world.wait({duration_s})` to wait for execution. Stop clears the buffer.
