# Tools and skills

For ROS devices, use the [async protocol API](communication.md). The world device
owns timing, and `lib.frames` uses tf2 with ROS frame IDs.

`@kinex/core` provides tools for operating devices, a runner for Python programs
with a library of functions for them, and a skill for preparing devices. Tools execute code; skills supply instructions
that the agent follows. These
built-ins complement the host's coding tools, such as shell and file editing.

## Built-in tools

### Device access and workspace

| Tool | Purpose |
| --- | --- |
| `device` | Call one device: read observations, submit commands, run inference, or load/unload it. |
| `devices` | Call multiple devices concurrently, returning results in input order with per-call errors. |
| `device_stop` | Stop a device or every loaded device with a stop operation, within declared stop scopes, and cancel running scripts that commanded a stopped device; no approval required. |
| `profile_write` | Validate and save workspace/device facts. New devices remain unloaded. |
| `record` | Start/stop observation capture, take snapshots and inspect recordings. Exposed to the model only when recording is enabled. |
| `skill` | Load a named skill's instructions into the agent's context. |

### Programs and the library: `exec` and `lib`

| Tool | Purpose |
| --- | --- |
| `exec` | Run a complete Python program in Kinex Python, given as source or as a saved file. |
| `lib` | Browse the function library one level at a time: modules, then a module's functions, then a function's signature and docstring. Read-only; no approval. |

A **program** is a complete Python script that ends with `finish`. It is what
`exec` runs, and the same text whether the agent passes it inline or saves it as a
file, by convention under `.kinex/programs`. The **library** is what programs
import: reusable functions in the `kinex.lib` package. A program is an entry
point; a library function is a part of one.

### Running with `exec`

Supply exactly one of:

- `python`: the program's source.
- `file`: the path of a saved program, relative to the working directory or
  absolute.

`args` supplies values the program reads with `kinex.args()`, and `argv` fills
`sys.argv[1:]`.

```python
import asyncio
from kinex import args, device, finish, lib

async def main():
    state = await device("arm").topic("joint_state").next()
    image, depth = await lib.images.camera_frame(args()["camera"])
    finish({"positions": state.position}, file=[image])

asyncio.run(main())
```

`finish(result=None, file=None)` ends the program and is the only way it returns:

- `result` is JSON-ready data. ROS messages, poses, NumPy values, dataclasses and
  tuples are converted: a pose to seven numbers, a time to seconds and a
  non-finite number to `null`.
- `file` attaches images for the model: an image message, an image path, or a
  list of them, in order. Images are never data, so an image in `result` is an
  error, and nothing outside `file` is attached.

A program that ends without `finish` returns `null`. Failure is an uncaught
exception; its traceback appears once, in the error. Printed text comes back as
bounded output.

`device(name)` is a loaded device, with the topics, services and actions its profile
declares, and `world` is the world device's time: `now`, `wait` and the ticks made
of it; a goal is awaited to wait for its end. Library functions use the same ones, so they take no scope
parameter and compose with ordinary Python, `asyncio.gather` included. A program
attaches to the workspace's Python runtime, where its devices are already loaded, and
runs one `asyncio.run(main())`; Kinex releases what it made when it ends. See
[devices in a program](communication.md#devices-in-a-program) and
[world time](communication.md#world-time).

| Caller | Invocation |
| --- | --- |
| Agent | `exec {file: ".kinex/programs/pick_place.py", args: {object: "red block", target: "blue pad"}}` |
| User | `/exec .kinex/programs/pick_place.py object="red block" target="blue pad"` |
| Shell | `kinex run '/exec .kinex/programs/pick_place.py object="red block" target="blue pad"'` |

The agent receives the result as text and the files in `file` as images. After a
user's `/exec` the agent reads the same text, which names the files by path;
standalone draws the images for the user under the command's row.

Use bounded Python loops for feedback control and settling checks; their control
flow, state and stopping conditions belong in the code. A typical sequence is:

1. Read measured state and compute or submit a control action.
2. Wait on the world, with `world.wait` or by awaiting a goal, when needed;
   choose an explicit interval for replanning during motion.
3. Check fresh feedback, faults and the task's tolerances. Bound retries and
   elapsed time; position agreement alone does not establish stability or task
   success. Cached observations do not supply new evidence.
4. Call the device's `stop` operation when the loop's exit requires it; a
   successful invocation leaves motion running.
5. Finish with the camera images the next decision needs.

One execution approval covers an invocation's reads and commands; Python cannot
load/unload devices or control recording. A failed, timed-out or cancelled
invocation stops every device it commanded, and a device stop cancels the
invocations that commanded it; see
[commands and cleanup](communication.md#commands-and-cleanup). Each invocation
uses a fresh process with a default 120-second wall-clock `timeout_s` and returns
its bounded printed output with the result or an error.

See [Python scripting](../packages/core/README.md#python-scripting) for all inputs,
the [control example](../packages/core/README.md#feedback-control-with-exec) for a
bounded loop that attaches multiple camera images, and [device contracts](devices.md)
for the underlying interfaces.

### The function library

The library is one Python package, `kinex.lib`, with several roots: the
workspace's `.kinex/lib`, its ancestors', the global configuration's and the
builtin modules shipped with core. A module in a nearer root replaces one of the
same name farther away. Builtin modules cover frames (`frames`), cameras
(`images`), kinematics (`kinematics`) and trajectory planning (`motion`).

Save code that several programs share as a module under `.kinex/lib`, at any
depth: a docstring saying what the module contains, then functions with typed
signatures and docstrings, `async` when they use devices or the world.

```python
# .kinex/lib/tabletop.py
"""Tabletop manipulation for this cell. Poses are in arm/base."""
from kinex import device, world
from kinex.lib import frames, images

async def grasp(object: str, arm: str = "arm") -> dict:
    """Close on the detected object, retrying once, and return the measured width."""
    ...
```

A program calls it as `await lib.tabletop.grasp("red block")`, and other library
functions import it from `kinex.lib.tabletop`.

### Browsing with `lib`

The library can have any depth and structure: the tree is exactly what Python's
import system resolves, read from source without starting Python. `lib` takes one
optional dotted `path` and returns one node:

| Path | Node |
| --- | --- |
| omitted | The library: its top-level modules with origin and a one-line summary. |
| `images` | A module: its docstring, its submodules and the names of the public functions it defines. |
| `images.camera_frame` | A function: its `def` header as written, its docstring, and the source file and line. |

```ts
Module   = { kind: "module", path, file | null, origin | null, doc, modules: [{ name, origin | null, summary }], functions: [name] }
Function = { kind: "function", path, file, line, signature, doc }
Result   = { node: Module | Function, problems: [text] }
```

`origin` is `workspace`, `global` or `builtin`. A package is a module with
submodules; a directory without `__init__.py` is a module with no file, merged
across roots as Python merges it. Names starting with an underscore, non-Python
files and nested or conditional definitions are not listed; classes are described
by their module. A function is listed where it is defined. `problems` reports
files whose names cannot be imported and a submodule that hides a function of the
same name. Only the top-level module list enters the agent's context; everything
deeper is read on demand.

### Subagents in programs

A program, or a library function it calls, asks a model for a judgment with
`subagent`, so a saved closed-loop task can decide what it sees without the main
agent:

```python
# .kinex/lib/judge.py
"""Judgments a model makes for a program."""
import json
from kinex import subagent

async def centring(object: str, front, wrist) -> dict:
    """Whether the object is centred in both views, with its pixel in each."""
    reply = await subagent(
        f"Find the {object} in both views. Answer as JSON: "
        '{"verdict": "centred|off_centre|not_visible", "front_px": [x, y], "wrist_px": [x, y]}',
        show={"front": front, "wrist": wrist})
    return json.loads(reply)
```

`await subagent(instruction, show=None, model=None, thinking=None, timeout_s=60)`
returns the reply as text. The subagent sees only the instruction and the named
items in `show`: a camera image message or an image `Path` is shown as an image,
any other value as text. It has no tools, no memory of other calls and none of the
main agent's context. The program states the form of the reply, parses it and
checks it before acting; a reply it cannot use is an ordinary Python error to
retry, or a reason to finish with the images for the main agent. Calls run alongside
other work (`asyncio.gather` included), count against the invocation's time limit,
and end with the invocation. The program waits for a reply but the robot does not,
so ask where the robot is at rest.

Each reply is written to the invocation's output as
`subagent <model> (<seconds> s): <reply>`, so whoever reads the result sees why the
program went the way it did. A failed call raises `kinex.RPCError` with code
`subagent_failed`, or `subagent_unavailable` on a host that runs no subagents.

Core defines only the exchange; the host answers it. Standalone runs each call as
a Pi session of its own, without tools, on the application's model runtime, so
every provider and credential configured for Kinex serves it. `/subagent
<provider/model> [thinking]` chooses the model for all later calls and
`/subagent session` returns to the session's model, which is also the default; the
choice is kept in `subagent.json` of the Kinex configuration directory. A call's
`model` and `thinking` override it. The plugins' hosts run no subagents yet.

### Flow charts

`/visualize .kinex/programs/pick_place.py` draws a saved program for the user to
read, and `/visualize tabletop.grasp` or `/visualize file.py:function` one
function: a self-contained HTML page derived from source alone, so nothing runs
and no device is touched. It is a user command, not a model tool.

A program's chart is its top-level statements, with the `main` that
`asyncio.run(main())` starts opened in place. A chart is a tree of steps rather
than a graph of statements:

| Step | From |
| --- | --- |
| Subagent | `subagent(...)`, with the first line of its instruction and the names of what it is shown |
| Device operation | A topic's `next` or `publish`, a service call and an action's goal, labelled with the operation; a computed name shows its expression |
| Wait | `world.wait` with its seconds, and each tick of `world.rate` |
| Call | A call to a library function, a function of the same file or, for a file outside the library, of a sibling module. One node, which opens into the callee's chart |
| Computation | Consecutive statements that touch no device and call no charted function, folded into one node; branches and loops that only compute fold with them |
| Branch, loop, try, scope | `if`/`match`, `for`/`while`, `try`, `with`; a test that only leaves (`if error: raise`) is one guard node |
| Concurrency | `asyncio.gather` and `asyncio.wait` as branches between two bars, `create_task` as a task running alongside until it is awaited or cancelled, `asyncio.timeout`/`wait_for` as scopes |
| Exit | `finish`, `return`, `raise`, `break`, `continue` |

An `await` on its own is an ordinary step: only the constructs above run things at
the same time. The chart shows what the source says. A function passed as a
value, a method of an object and anything in `kinex.common` cannot be opened: it
is a plain node where the program awaits it and part of the computation otherwise.
Failure cleanup (stopping the commanded devices) is not drawn. Calls are named by
library path however the code imports them. `kinex.host.flow` produces the
chart as the `Flow` schema of `@kinex/core/lib/flow`; the page is the viewer asset
with that data embedded.

## Built-in skill

Core ships [setup-device](../packages/core/assets/builtin/skill/setup-device/SKILL.md).
It guides the agent through selecting a device guide, provisioning a node,
writing a profile and verifying the interface, including ROS dependencies and
Kinex Python for ROS workspaces. It also supports node repair. The agent performs
these steps through tools; loading the skill does not run them automatically.

`@kinex/setup` adds the onboarding and calibration workflows, the `setup_plan` tool,
the `kinex.lib.calibration` library that exec programs sample and solve with, and
calibration and base-verification skills; see [setup and calibration](setup.md). For tool arguments and examples,
see the [core API](../packages/core/README.md#device-calls-and-control).

[Design index](README.md)
