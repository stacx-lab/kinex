---
name: world
type: world
description: The world's time and its waits, with optional scene geometry.
---

## Setup

Every workspace requires exactly one world device per ROS domain. It keeps time for
every device node, tf2 lookup and recording, and it is where programs wait. Keep
task instructions and benchmark judging out of its operations.

Every world, the real one or a simulator's, declares the same three operations with
the names, types and descriptions below: they are what a program's `world` object
calls and what the model reads in the profile. Worlds differ only in whether time
passes by itself. In the real world and in a simulator running in real time it does,
and a wait only answers once its time is over. A stepped simulator advances only
during a wait and rests otherwise. The profile says neither.

A program also waits for goals to end, by awaiting them. Where time passes by itself
that needs nothing of the world: each device tells the program when its goal has ended.
A stepped simulator, which executes its devices' goals, must stop on the step a goal
ends at, so there the wait ends when a goal does, and the reply names it.

The world also publishes its time on the domain's `/clock`
(`rosgraph_msgs/msg/Clock`, reliable and `transient_local`), which Kinex's device
nodes, tf2 history and recording follow. It is not an operation: do not declare it,
and let no other node publish `/clock` in the domain. A world has no `reset`: an
episode starts with its world.

A physical workspace copies the sibling `node.py`: it publishes system time on
`/clock` and serves the three operations against it.

### Operations

- `now`: service `custom_interfaces/srv/Now`, no request fields. It replies
  `time_s`, world time in seconds, and the time budget in seconds of world time,
  `used_s` spent of `max_s` allowed: NaN for both without a budget, as in the real
  world, and an infinite `max_s` without a limit. `used_s` may include
  initialization, so it can differ from `time_s`. Kinex reports the budget as
  supplied and does not enforce it.
- `wait`: service `custom_interfaces/srv/Wait`. It waits `seconds` of world time and
  replies `time_s`, the world time reached; no seconds is an observation barrier. A
  world that executes goals ends the wait when one of them ends, or at once when one
  has ended since its previous reply, and lists their ids in `ended`; a world that
  executes none leaves `ended` empty. Infinite `seconds` wait for a goal's end alone,
  for a program that awaits only goals: a world that executes none answers at once,
  and one where time passes by itself waits until its `stop`. A world admits one wait
  at a time and rejects a second with `success` false.
- `stop`: service `std_srvs/srv/Trigger` that cancels the pending wait. Kinex calls
  it when what a program waits for changes, and when a program fails during a wait or
  abandons one.

A world may end a wait early with `success` false, for example when a device refuses
a command: `time_s` says how far it ran, and a stepped world never advances the rest.
The wait's `timeout_s` bounds the wall time of one call.

### Profile

```yaml
name: world
type: world
loaded: false
description: World time and waits.
runtime:
  observation: now
  nodes: [{entry: node.py, factory: create}]
operations:
  now:
    description: 'World time, time_s, and the time budget in seconds of world time: used_s spent of max_s allowed. Without a budget both are NaN; without a limit max_s is inf.'
    transport: service
    direction: input
    endpoint: /kinex/world/now
    type: custom_interfaces/srv/Now
  wait:
    description: 'Wait seconds of world time: the reply gives time_s, the world time reached. A world that executes goals ends the wait when one ends, and names it in ended. One wait at a time: a second is rejected.'
    transport: service
    direction: input
    endpoint: /kinex/world/wait
    type: custom_interfaces/srv/Wait
    timeout_s: 120
  stop:
    description: Cancel the pending wait.
    transport: service
    direction: input
    endpoint: /kinex/world/stop
    type: std_srvs/srv/Trigger
bounds: ???
surfaces: []
frames:
  base: {parent: null, translation_m: null, rotation_xyzw: null}
```

Bounds are `{min: [x, y, z], max: [x, y, z]}` in metres; null bounds impose no box,
null sides are open, and `???` means unresolved. Surfaces have a unique name, a
world pose and a rectangle, polygon or unbounded extent. Record only measured
geometry.
