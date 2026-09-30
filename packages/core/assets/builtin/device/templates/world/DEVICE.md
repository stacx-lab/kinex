---
name: world
type: world
description: World clock and optional spatial reference.
---

## Setup

The supplied driver uses a real-world monotonic clock. Remote environments supply
their own driver. Configure access and load the device before read/wait.

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

`read()` returns `time_s` and optional `budget: {elapsed_s, max_s}`: episode seconds
consumed and allowed. `max_s: null` means no cap. Budget is informational;
Kinex does not enforce it.

`wait({duration_s})` waits in world time and returns `{time_s, elapsed_s}`;
`elapsed_s` is the actual duration of that wait. Waits are concurrent and
individually cancellable.

Optional bounds and surfaces are informational: they do not constrain motion
or establish transforms between disconnected frame trees.
