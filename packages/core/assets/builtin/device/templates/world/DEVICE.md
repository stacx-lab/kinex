---
name: world
type: world
description: World clock and optional spatial reference.
---

## Use

`read()` returns `{time_s}`. `wait({duration_s})` waits in world time and returns
`{time_s, elapsed_s}`. Waits are concurrent and individually cancellable.
The driver abstracts the clock; callers do not select an execution mode.

World geometry is optional. Bounds and posed surfaces are informational;
they do not constrain motion or imply transforms between disconnected frame trees.
Named frames are fixed; `null` live transforms are not supported on world.

## Setup

The supplied driver uses a real-world monotonic clock. Remote environments supply
their own driver. Configure access and load the device before read/wait.

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
