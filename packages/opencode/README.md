# @kinex/opencode

Kinex robotics in OpenCode **1.18.31**, with separate server and TUI entrypoints.
The first release targets same-machine Linux/macOS. The server owns one runtime
per OpenCode workspace instance; the TUI uses a private local Unix socket.

## Install before npm publication

Use OpenCode **1.18.31**. From your robot workspace, install the built local package:

```sh
/path/to/kinex/node_modules/.bin/opencode plugin file:///path/to/kinex/packages/opencode
/path/to/kinex/node_modules/.bin/opencode
```

The native installer detects both package entrypoints and updates the server and
TUI configuration automatically. Add `--global` to install for all workspaces.
This registers the local checkout; keep it available and rebuild/restart OpenCode
after changing the adapter. Build it first with `npm ci && npm run build` from the
Kinex repository if `packages/opencode/dist` is absent.

To install independent packaged artifacts instead, build the repository and run
`npm run pack -- /tmp/kinex-release`, then:

```sh
npm install --prefix /path/to/kinex-plugins \
  /tmp/kinex-release/kinex-core-0.8.0.tgz \
  /tmp/kinex-release/kinex-opencode-0.8.0.tgz
opencode plugin file:///path/to/kinex-plugins/node_modules/@kinex/opencode
```

This does not require standalone Kinex or an adjacent core checkout. After npm
publication, use `opencode plugin @kinex/opencode@0.8.0`.

For manual configuration, use `file:///.../dist/server.js` in the `plugin` array
of `opencode.json` and `file:///.../dist/tui.js` in `.opencode/tui.json`. Choose one
installation method: remove those explicit file entries before registering the
package directory, to avoid loading the same plugin twice.

## Direct commands and model tools

`/load`, `/unload`, `/reload`, `/devices`, `/ping`, `/stop`, `/unregister` and
`/record` use native selection/input dialogs. They execute directly, with no model
request. `/onboarding`, `/register` and `/calibrate` submit workflows to the host.
All commands have `/kinex-NAME` aliases; existing host slash names are retained.
The first command on the home screen creates a session without invoking a model.
`/kinex-connect` reconnects after a workspace change or selects among local instances.

Headless/model access uses two fixed tools:

- `kinex_tools`: list current tool schemas and skills; pass `skill` to load a skill.
- `kinex_call`: invoke a tool with `name` and `arguments` from its current schema.

The directory refreshes before each model request, including inside a running task.
Custom tools need no restart. Removed tools cannot be called. Fixed host tool
definitions avoid registry mutation; state/catalog changes are appended to context.
Projection history lives in the nearest robotics workspace’s `.kinex/agent/opencode/context/`, with stable anchors
for replay and a fresh snapshot after compaction. It is local workspace state and
does not travel with OpenCode's own session exports/forks.

Core explicit denies are retained and device permissions go through OpenCode's
native approval mechanism. Configure `device_act`, `device_read`,
`device_calibrate`, `calib_write` and `record` in host permissions as needed.
The adapter does not change OpenCode's global permission policy. Emergency stop
does not wait for the Kinex execution queue.

Model recording is off by default. Enable it using a server plugin tuple:
`["file:///.../server.js", {"enableRecording": true}]`.
Manual recording commands remain available. A session cannot take over another
session's active recording; its non-emergency Kinex operations are blocked until that recording ends. Host transcript messages supply recording references.

Kinex calls execute serially; rejection/cancellation prevents queued Kinex calls
in that run. Already-running host coding tools cannot be rolled back. Runtime and
IPC resources close on plugin disposal or process shutdown. Disconnecting TUI
cancels its command/dialog without destroying a still-running server runtime.

Remote attach direct commands, Windows IPC, and custom tools that require an
in-tool questionnaire are not supported in this first adapter. Use OpenCode's
native question tool before invoking such workflows; unanswered requests are
declined, never invented. Physical devices and live provider cache-hit rates need
separate environment validation.

## Additional feature packages

`createOpenCodePlugin({ contributions: runtime => [...] })` composes explicit
feature contributions. Include `coreContribution(runtime)` and the additional
packages. Tools, commands, skills and namespaced context use the same adapter;
feature packages own business logic and the product entrypoint owns the runtime.
