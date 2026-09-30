---
name: world
type: world
description: World clock and optional spatial reference.
---

## Use

`read()` returns `time_s` and optional `budget: {elapsed_s, max_s}`: episode seconds
consumed and allowed. `max_s: null` means no cap. Budget is informational;
Kinex does not enforce it.

`wait({duration_s})` waits in world time and returns `{time_s, elapsed_s}`;
`elapsed_s` is the actual duration of that wait. Waits are concurrent and
individually cancellable.

Optional bounds and surfaces are informational: they do not constrain motion
or establish transforms between disconnected frame trees.
