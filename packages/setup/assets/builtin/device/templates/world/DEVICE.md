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
