# Command reference

Start `kinex` in your robot workspace. The common CLI follows the bundled Pi SDK.
Run `kinex --help` or see [Getting Started](../README.md#getting-started).

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

| Command                                        | Purpose                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `/lib [module[.function]]`                     | Browse the program library: modules, a module's functions, a signature. |
| `/exec <module.function> [name=value ...]`     | Run a library program without the model.                                |
| `/visualize <module.function> [output.html]`   | Draw a program's flow chart as a page to open in a browser.             |
| `/subagent [<provider/model> [thinking]]`      | Show or choose the model that subagents in programs use.                |

`/exec` passes `name=value` pairs as keyword arguments; a value is JSON when it
parses (`attempts=3`, `pose=[0.1,0.2]`, `object="red block"`) and text otherwise,
and one JSON object may replace the pairs. `/stop` cancels it like any other
invocation. From the shell, `kinex run '/exec tabletop.pick_place object="red block"'`
runs a saved program and exits.

`/visualize` reads the program's source without running it and writes one self-contained
page, by default `.kinex/flow/<module.function>.html`. Each device operation, wait
and call is a node; clicking a call opens that function's own chart in place, and
clicking any node shows its source lines. `/visualize path/to/script.py[:function]` charts
a function of a file outside the library, `main` by default. See
[flow charts](tools-and-skills.md#flow-charts).

`/subagent` shows the model that [subagents in programs](tools-and-skills.md#subagents-in-programs)
use. `/subagent <provider/model> [thinking]` chooses it for every later call, with
thinking `off` unless given, and `/subagent session` returns to the session's model.
The choice persists across sessions and workspaces.

### Recording and session export

Capture device observations with `/record` and preserve the conversation with
Pi's `/export`. These examples use a RoboTwin workspace that
[rosbridge](https://github.com/stacx-lab/rosbridge) exports with
`rosbridge setup robotwin/robotwin-aloha-agilex --directory DIR --domain-id N`.
Start a task on the same domain with
`rosbridge launch <task> --execution-mode stepped|realtime --domain-id N`; see
[simulators](../README.md#use-kinex-with-simulators).

| Command                                   | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `/record start left_arm=10 head_camera=2` | Record the left arm at 10 Hz and head camera at 2 Hz.                   |
| `/record snap <devices ...>`              | Capture a one-time snapshot of the named devices.                       |
| `/record stop [outcome] [summary]`        | Finish and save; optional outcome `success`, `failure` or `partial`.    |
| `/record status`                          | Show the active recording and summaries of recent ones.                 |
| `/export [path]`                          | Export the current conversation session as HTML or JSONL.               |

### Real-world setup

| Command                     | Purpose                                     |
| --------------------------- | ------------------------------------------- |
| `/onboarding [description]` | Prepare the robot and task prerequisites.   |
| `/calibrate [scope]`        | Resolve selected calibration prerequisites. |

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
