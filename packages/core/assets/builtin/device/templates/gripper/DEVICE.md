---
name: gripper
type: gripper
description: gripper control and observation contract.
---

## Use

`write({actions: [value, ...], duration_s})` submits a flat sequence of commands.
Use `[value]` for one command. Values use the profile's units and command semantics.
Optional `speedFraction` applies to the whole sequence when supported.
The final reference remains active after the buffer completes.
New valid writes replace pending actions without stopping. Results contain
`execution_id`, actual `elapsed_s` and measured `state`.
Use `world.wait({duration_s})` to wait for execution. Stop clears the buffer.
