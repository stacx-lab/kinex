---
name: world
type: world
description: World clock and optional spatial reference.
---

## Setup

The supplied driver uses a real-world monotonic clock. Remote environments supply
their own driver. Configure access and load the device before read/wait.

### Clock driver

Implement read/wait on the environment's clock in seconds. Each wait supports
independent cancellation through `{id, interrupt: request_id}`; concurrent waits
share world time. Reads never advance it. Report budget consumption separately
from clock time and per-wait duration; initialization may consume budget.

### Profile

```yaml
name: world
type: world
loaded: false
access:
  connection: {kind: process}
  driver:
    entry: driver.py
    persistent: true
    actions: [read, wait, load, unload, status]
intrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  frames: {}
  bounds: null
  surfaces: []
```

Bounds are `{min: [x,y,z], max: [x,y,z]}` in metres; null bounds impose no box,
null sides are open, and `???` means unresolved. Surfaces have a unique name,
world pose and rectangle, polygon or unbounded extent. Use only measured geometry.

## Use

`read()` returns clock `time_s` and optional `budget: {used_s, max_s}`:
episode seconds consumed and allowed; null `max_s` means no cap.
`wait({duration_s})` returns completion `time_s` and actual `waited_s` for that
wait. The clock can advance between calls; differences between reads are not
necessarily wait durations. Reads do not advance time; waits are concurrent
and individually cancellable.

Budget, bounds and surfaces are informational; Kinex does not enforce them or
infer transforms between disconnected frame trees.
