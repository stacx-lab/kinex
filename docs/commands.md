# Command reference

Start `kinex` in your robot workspace. The common CLI follows the bundled Pi SDK.
Run `kinex --help` or see [Getting Started](../README.md#quick-start).

## In-session commands

### Coding-agent controls

These commands manage the usual coding-agent workflow. Pi supplies the model,
session and resource commands; Kinex adds `/mode` for permissions and interaction.

| Command                   | Purpose                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `/login`, `/model`        | Connect a provider and select a model.                             |
| `/mode [ask\|auto\|yolo]` | Choose tool approval and interaction behavior.                     |
| `/settings`               | Open agent settings.                                               |
| `/new`, `/resume`         | Start a new session or switch to a saved one.                      |
| `/compact [instructions]` | Compact conversation context, optionally with custom instructions. |
| `/reload`                 | Refresh agent resources, including extensions and skills.          |

### Device management

| Command                                        | Purpose                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/register <type-or-template>`                 | Prepare an unloaded device profile.                                                   |
| `/unregister <device>`                         | Confirm removal, then unload and delete the device's profile, node and local files. |
| `/devices`                                     | List devices and their loaded/unloaded state.                                         |
| `/ping <device\|all>`                          | Inspect live device status.                                                           |
| `/load <device\|all>`, `/unload <device\|all>` | Connect or release devices.                                                           |
| `/stop [device]`                               | Cancel the response and stop actuators within their stop scope.                       |

To restart device connections after changing profiles or restarting a simulator,
use `/unload <device>` followed by `/load <device>`, or restart Kinex. Use `all` to
reconnect the whole collection. `/reload` refreshes agent resources only.

### Programs

| Command                                              | Purpose                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `/exec <file.py> [name=value ...]`                   | Run a saved program without the model.                                   |
| `/lib [module[.function]]`                           | Browse the function library: modules, a module's functions, a signature. |
| `/visualize <file.py[:function]\|module.function> [output.html]` | Draw the flow chart of a program or function as a page to open in a browser. |

`/exec` runs a program file, by convention one under `.kinex/programs`, and passes
`name=value` pairs as the arguments the program reads with `args()`; a value is
JSON when it parses (`attempts=3`, `pose=[0.1,0.2]`, `object="red block"`) and text
otherwise, and one JSON object may replace the pairs. `/stop` cancels it like any
other invocation. From the shell,
`kinex run '/exec .kinex/programs/pick_place.py object="red block"'` runs a saved
program and exits. `/exec` first waits for the workspace's loaded devices
that are still connecting, so a program run as Kinex starts finds them ready.

In the terminal a command is drawn as the tool row it resembles: pending with its
elapsed time while it runs, then its result or failure. While the agent is idle,
Escape cancels the running command; during an agent run Escape ends both. The model
reads the result as text that names the user's command and lists attached images as file
paths; the images themselves are drawn under the row where the terminal can.

`/visualize` reads source without running it and writes one self-contained page, by
default under `.kinex/flow/`. `/visualize path/to/program.py` charts a whole program,
`path/to/file.py:function` one of a file's functions and `module.function` a library
function. Each device operation, wait and call is a node; clicking a call opens that
function's own chart in place, and clicking any node shows its source lines. See
[flow charts](tools-and-skills.md#flow-charts).

### Recording and session export

Capture device observations with `/record` and preserve the conversation with
Pi's `/export`. These examples use a RoboTwin workspace that
[kinex-sim](https://github.com/stacx-lab/kinex-sim) exports with
`kinex-sim setup <task> --directory DIR --domain-id N`.
Start that task on the same domain with
`kinex-sim launch <task> --execution-mode stepped|realtime --domain-id N`; see
[simulators](../README.md#simulators).

| Command                                   | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `/record start left_arm=10 head_camera=2` | Record the left arm at 10 Hz and head camera at 2 Hz.                   |
| `/record start head_camera.image=10 head_camera.depth=2` | Record only those operations, each at its own rate.      |
| `/record snap <devices ...>`              | Capture a one-time snapshot of the named devices.                       |
| `/record stop [outcome] [summary]`        | Finish and save; optional outcome `success`, `failure` or `partial`.    |
| `/record status`                          | Show the active recording and summaries of recent ones.                 |
| `/export [path]`                          | Export the current conversation session as HTML or JSONL.               |

`<device>=<Hz>` records every declared topic of the device. `<device>.<operation>=<Hz>`
gives one operation its own rate, alongside the device's rate or, without one, as the
only operations recorded. Color images are stored as H.264 video and everything else,
depth included, in a compressed bag; `<device>.<operation>=<Hz>:bag` keeps a color
stream's exact pixels instead. Depth is the bulk of a camera recording, so lower its
rate or leave it out when it is not needed. See
[recording](agent-integration.md#recording) for the products.

### Real-world setup

| Command                     | Purpose                                     |
| --------------------------- | ------------------------------------------- |
| `/onboarding [description]` | Prepare the robot and task prerequisites.   |
| `/calibrate [scope]`        | Resolve selected calibration prerequisites. |

### Self-improvement

| Command                                  | Purpose                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `/code-as-skill <what to practise>`      | Plan a run of simulated tasks with the session; it starts once you approve.  |
| `/code-as-skill status [run]`            | Show trials, distillations and tasks solved per library version.             |
| `/code-as-skill install <version> [run]` | Copy a published library version into this workspace.                        |
| `/code-as-skill resume [run]`            | Schedule a run again from what is on disk.                                   |
| `/code-as-skill stop`                    | End a run's running trials and distillations.                                |
| `/code-as-policy`                        | Not implemented yet: practise one task over seeds and layouts into a program. |

Approving a plan moves Kinex from `ask` to `auto` mode: trials and distillations
run as background sub-agents with nobody to approve their steps, each in a
bubblewrap or Docker sandbox. Runs belong to the workspace they were planned in
(`.kinex/self-improve/code-as-skill/runs/`): `[run]` names one of its runs, or another
workspace's run by its folder.

## Shell commands

| Command                                      | Purpose                                      |
| -------------------------------------------- | -------------------------------------------- |
| `kinex ["prompt"]`                           | Start an interactive session.                |
| `kinex run "prompt"`, `kinex -p "prompt"`    | Process a prompt and exit.                   |
| `kinex --mode json "prompt"`                 | Emit events as JSON lines.                   |
| `kinex --continue`                           | Continue the latest workspace session.       |
| `kinex --resume`                             | Choose a saved session; requires a terminal. |
| `kinex --session <path-or-id>`               | Open a specific session.                     |
| `kinex --model <provider/model>`             | Select a model.                              |
| `kinex --thinking <level>`                   | Set reasoning effort.                        |
| `kinex --export session.jsonl [output.html]` | Export a saved session.                      |
| `kinex update`                               | Update Kinex and its bundled Pi SDK.         |
| `kinex update --extensions`                  | Update installed packages, preserving pins.  |
| `kinex update --all`                         | Update both Kinex and installed packages.    |

Prompts run in order; piped input is prepended to the first prompt. Use `--` before
prompts beginning with a dash. `kinex run` and `-p` are aliases for `--print`.

Use `--auto` to approve tool permissions while retaining user questions, or
`--yolo` to also disable questions. `--enable-recording` exposes recording controls
to the model. To record a non-interactive task:

```sh
kinex -p --record "left_arm=10 head_camera=2" \
  "Inspect the RoboTwin scene and describe the block and target pad."
```

See [device contracts](devices.md), [recording](agent-integration.md#recording) and
[setup and calibration](setup.md) for the underlying contracts.
