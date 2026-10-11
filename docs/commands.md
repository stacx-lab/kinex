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
| `/unregister <device>`                         | Confirm removal, then unload and delete the device's profile, driver and local files. |
| `/devices`                                     | List devices and their loaded/unloaded state.                                         |
| `/ping <device\|all>`                          | Inspect live device status.                                                           |
| `/load <device\|all>`, `/unload <device\|all>` | Connect or release devices.                                                           |
| `/stop [device]`                               | Cancel the response and stop actuators within their stop scope.                       |

To restart device connections after changing profiles or restarting a simulator,
use `/unload <device>` followed by `/load <device>`, or restart Kinex. Use `all` to
reconnect the whole collection. `/reload` refreshes agent resources only.

### Recording and session export

Capture device observations with `/record` and preserve the conversation with
Pi's `/export`.

| Command                         | Purpose                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `/record start arm=10 camera=2` | Start recording arm observations at 10 Hz and camera observations at 2 Hz. |
| `/record snap <devices ...>`    | Capture a one-time snapshot of the named devices.                          |
| `/record stop`                  | Finish and save the active recording.                                      |
| `/record status`                | Show active and recent recordings.                                         |
| `/export [path]`                | Export the current conversation session as HTML or JSONL.                  |

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
kinex -p --record "arm=10 camera=2" "prompt"
```

See [device contracts](devices.md), [recording](agent-integration.md#recording) and
[setup and calibration](setup.md) for the underlying contracts.
