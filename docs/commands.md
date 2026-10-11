# Command reference

Start `kinex` in your robot workspace. The common CLI follows the bundled Pi SDK.
Run `kinex --help` or see [Getting Started](../README.md#getting-started).

## Shell commands

| Command | Purpose |
| --- | --- |
| `kinex "prompt"` | Start an interactive session with a prompt. |
| `kinex run "prompt"`, `kinex -p "prompt"`, `kinex --print "prompt"` | Process a prompt and exit. |
| `kinex --mode json "prompt"` | Emit SDK events as JSON lines. |
| `kinex -c`, `kinex --continue` | Continue the latest workspace session. |
| `kinex -r`, `kinex --resume` | Choose a saved session in the terminal picker. |
| `kinex --session <path-or-id>` | Open a session file or a full or unique prefix ID. |
| `kinex --model <pattern>` | Select a model using Pi matching, including `provider/model`. |
| `kinex --provider <name> --model <pattern>` | Restrict model selection to a provider. |
| `kinex --thinking <level>` | Set `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `kinex --export session.jsonl [output.html]` | Export a session without a model request. |
| `kinex update`, `kinex update --self` | Update Kinex and its bundled Pi SDK. |
| `kinex update --extensions`, `kinex update <source>` | Update all installed packages or one package, preserving pins. |
| `kinex update --all` | Update Kinex and then its installed packages. |

Use `--model <pattern>:<thinking>` for Pi's thinking shorthand; an explicit
`--thinking` takes precedence. Multiple positional prompts run in order. Piped
text is prepended to the first prompt, and redirected input or output selects
non-interactive execution. Use `--` before prompts beginning with a dash.
The resume picker needs a terminal; scripts can use `--session` or `--continue`.
Sessions keep Kinex's existing storage locations. The exit hint opens the exact
saved session, even from another directory.

Kinex retains `--auto` (approve tool permissions, keep interviews), `--yolo`
(approve permissions and disable interviews), and `--enable-recording`
(expose recording controls to the model). For non-interactive recording, use
`kinex -p --record "arm=10 camera=2" "prompt"`.

`kinex run` is a shorthand for `kinex --print`, with the same options, piped input,
and multiple-prompt behavior. Use `kinex -- run` to submit the literal prompt `run`.

Replace `--seed "prompt"` with a positional
prompt, `--json` with `--mode json`, `--effort` with `--thinking`, and
`kinex upgrade` with `kinex update`. These old options are not aliases. Existing
package-update scripts using bare `kinex update` must use
`kinex update --extensions` instead. RPC mode, `@file` attachments, and advanced
Pi tool/resource flags are not supported by this CLI. `install`, `remove`,
`uninstall`, and `list` are unchanged.

## In-session commands

| Command | Purpose |
| --- | --- |
| `/login`, `/model` | Connect a provider and select a model. |
| `/onboarding [description]` | Prepare the robot and task prerequisites. |
| `/register <type-or-template>` | Create an unloaded device profile. |
| `/devices`, `/ping <device\|all>` | List devices or inspect live services. |
| `/load <device\|all>`, `/unload <device\|all>` | Connect or release devices. |
| `/stop [device]` | Cancel the response and stop actuators within their stop scope. |
| `/record start arm=10 camera=2`, `/record stop` | Start or finish recording. |
| `/calibrate [scope]` | Resolve selected calibration prerequisites. |
| `/mode [ask\|auto\|yolo]` | Choose tool approval and interaction behavior. |

Pi provides commands such as `/settings`, `/new`, `/resume`, and `/compact`.
`/reload` refreshes agent resources. To restart device connections after changing
profiles or restarting a simulator, use `/unload <device>` followed by
`/load <device>`, or restart Kinex. Use `all` to reconnect the whole collection.

See [devices and recording](devices.md) and [setup and calibration](setup.md)
for the underlying contracts.
