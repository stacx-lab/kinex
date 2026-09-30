---
name: suction
type: suction
description: suction control and observation contract.
---

## Use

`write({actions: [value, ...], duration_s})` submits a flat sequence of commands.
Use `[value]` for one command. Each value must equal `on_target` or `off_target`.
The final reference remains active after the buffer completes.
New valid writes replace pending actions without stopping. Results contain
`execution_id`, actual `elapsed_s` and measured `state`.
Use `world.wait({duration_s})` to wait for execution. Stop clears the buffer.
