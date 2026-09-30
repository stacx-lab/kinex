---
name: dexterous_hand
type: dexterous_hand
description: dexterous hand control and observation contract.
---

## Use

`write({actions, duration_s})` submits absolute joint vectors in model order
(radians/metres). The driver consumes the buffer at its fixed control cadence.
The last reference remains active after the buffer completes.
New valid writes replace pending actions without stopping. Results contain
`execution_id`, actual `elapsed_s` and measured `state`.
Use `world.wait({duration_s})` to wait for execution. Stop clears the buffer.
