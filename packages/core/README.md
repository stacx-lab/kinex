# @kinex/core

Kinex's robotics runtime for Node >=22.19. The standalone Kinex agent
uses this package directly; external host adapters can consume the same API.
It contains no model provider, agent loop, session store, terminal UI or MCP server.

```ts
import { createKinexRuntime } from "@kinex/core"

const runtime = createKinexRuntime({
  directory: process.cwd(),
  host: {
    ask: async (request) => { /* await the host's permission decision; throw on denial */ },
    questions: async (questions) => { /* use the host's question UI */ return {} },
  },
})
try {
  // Python is created lazily when an internal operation needs it.
  const activations = await runtime.devices.warmLoaded()
  // Observe each activation.ready for background loading failures.
  const { tools, problems } = await runtime.tools.list()
  // Register schemas with the host and route each invocation to tools.call.
  const context = await runtime.context()
  const result = await runtime.tools.call("device", { deviceID: "camera" }, {
    sessionID: "host-session", callID: "host-call", signal: new AbortController().signal,
  })
  // result includes text, error status, metadata and optional image file paths.
} finally {
  await runtime.dispose()
}
```

The permission callback is the authorization boundary. It must resolve only when
allowed and throw `PermissionDeniedError` when denied. With no host callbacks,
permission requests are denied and questionnaires are declined. Model tools keep
the existing device permissions. The device tool supports load/unload through
`device_act`; Python tools cannot change lifecycle. The `devices` lifecycle
methods and `profiles` methods are trusted host operations: expose them through
user commands, not unrestricted model tools. `enableRecording: true` exposes the
model's recording tool; the host can use `recording` methods independently.

## Shared user commands

The root exports `roboticsCommands`, `isRoboticsCommand()` and
`executeRoboticsCommand(runtime, name, arguments, context)`. The catalog provides
names, argument hints, descriptions and operation/workflow kinds. Execution returns
either `{kind: "output", text, isError?}` or `{kind: "workflow", prompt}`. The host
provides a session ID, deletion confirmation and optional progress notifications.
Hosts own command registration, display, agent cancellation for stop, and submission
of workflow prompts. This executor is a trusted user-command API, not a model tool.

## Feature contributions

`@kinex/core/integration` exports `KinexContribution`, `KinexCapabilities`,
`ContributionCommand`, `Invocation`, `ToolSchema`, `coreContribution(runtime)` and
`composeContributions(contributions)`. This is a host-independent capability
interface, not a second runtime or a dynamic extension loader.

```ts
import { coreContribution, composeContributions } from "@kinex/core/integration"
const capabilities = composeContributions([coreContribution(runtime)])
// Future: add a real-world contribution here, borrowing the same runtime.
const catalog = await capabilities.tools.list()
const state = await capabilities.context() // stable instructions + source.section keys
```

A contribution can provide tools (`list`/`call`), skills (`list`/`load`), commands
and context. Tools receive `Invocation` with session/call identity, abort signal,
permission and question callbacks. Commands receive a distinct trusted
`CommandContext`, including an optional abort signal. Load/reload also accept an
optional signal. Each feature must preserve authorization/cancellation internally.
Duplicate identifiers are errors; tool directories are re-read when calling.
A contribution borrows resources; the product that created the runtime disposes it.
The existing root APIs remain available without adopting contributions.

## Bounded control

Every actuated write requires positive `for_s` and returns `accepted`, `elapsed_s`,
`reached` and the resulting `state`. Drivers own the clock and execution; incomplete
acknowledgments are errors. A segment bounds the call; explicit stops halt standing
commands. Controller defaults stop on exit.

- `move_to`: fixed joints, pose or observed point; optional `until` predicate.
- `drive`: velocity/posture for required `duration_s`, optionally ending on `until`.
  Always stops; no displacement goals or continuation option.
- `track`: point perception followed only by `move_to`. Requires
  `control: {tool: "move_to", args: {device, timeout_s, ...}}`; each child budget is
  capped by the remaining total. Optional continuation applies between successful
  rounds, but a miss and every final exit stop the target.
- `run_policy`: standalone action chunk from an observation such as an `observe`
  bundle. Any commanded device fault stops the whole group.

Predicates are checked before motion and between writes at their device-time
interval (default one second). `on_timeout: continue`, where available, applies
only to budget exhaustion. Track's budget counts executed motion, not perception.

## Public runtime

- `tools.list()` returns input JSON schemas plus discovery problems; defaulted
  arguments remain optional for host validation. `tools.call()`
  rescans, validates arguments, checks permissions and returns normalized results.
- `skills.list()/load()` and `context()` provide discovered skills and live robotics
  context (shared instructions, type conventions, guide roots and Python environment)
  for the host's prompt. Python context includes `library` and `workspaceLibrary`
  paths for shells that need an explicit `PYTHONPATH`. Core does not edit the
  host's system prompt.
- `devices.warmLoaded()` restores already-loaded devices once per runtime and returns
  activation handles after reserving their initialization lanes. Await each `ready`
  for completion; failures remain per device. Disposal cancels pending initialization.
- `python.status()/initialize()/prepare({signal})` inspect, seed and synchronize the
  separate `.kinex/python` project. Status is read-only; initialize installs nothing.
  The project may be absent. Default Python execution prepares it on demand;
  shared prompt instructions include the default manifest for agent-led shell setup.
  Preparation returns the interpreter and child-process environment.
- `devices.list()/templates()/load()/reload()/unload()/ping()/unregister()` implement
  user device commands. Load/reload returns `{device, activating, ready}`; await
  `ready` for background initialization. `devices.dispatch()` is a trusted driver API.
- `profiles.snapshot()/writeManifest()/writeDevice()` and `calibration.plan()` expose
  workspace state. Profile writes validate using the existing schemas.
- `recording.start()/snap()/stop()/status()/recent()` manage recording products.
- `subscribe()` observes device, tool execution and recording events and returns an
  unsubscribe function. Listeners run synchronously and must not throw or block.
- `observe()` accepts host message boundaries for recording attribution. Optional
  `host.exportTrace(sessionID, range)` supplies a host-specific transcript snapshot;
  without it, recording has no transcript dependency or delayed export wait.
- `dispose()` is idempotent. It cancels active tool/device calls, finalizes recordings,
  waits for transcript export and closes child processes. Hosts must call it on
  workspace switch/shutdown. Custom tools must honor their abort signal.

Construction/import does not connect to hardware, write files, or install process
handlers. Each runtime owns its driver connections, dispatch lanes, mock state,
observers, model cache and recorder. Separate runtime instances isolate in-memory
state even when device names match. Disk profiles remain shared when the directory
is shared; use separate workspaces for independent persistent state.

`run()` binds low-level calls and their asynchronous work to a runtime scope.
Standalone and extension integrations should prefer bound runtime methods.
Exported subpaths support internal Kinex consumers; the root runtime API
is the intended integration surface.

`@kinex/core/workflows/index` exports shared `onboarding`, `register` and `calibrate`
prompt templates in `workflows`. Hosts substitute `$ARGUMENTS` and translate slash
command references to their own command namespace.

## Assets and discovery

`assets/` is the authoritative copy of device guides, built-in skills, Python tools,
and the Python client/bridge scripts. It ships in the npm package and resolves
relative to the package, never the caller's working directory. Standalone release
archives include the same package assets beside its built modules.

Discovery preserves workspace/project → parent projects → global → built-in
precedence. TypeScript and JavaScript custom tools reload on discovery through
Jiti. Tools can retain Zod schemas; Python tools keep raw JSON Schema parameters. Workspaces supply any dependencies imported by custom
tools. This code is trusted executable workspace content, like standalone Kinex.

Python and uv remain external. Core owns `.kinex/python/{pyproject.toml,uv.lock,.venv}`
per workspace; it never adopts the ordinary Python project. Default drivers/tools,
URDF inspection and camera encoders use it; explicit interpreters are supported.
Use `uv add --project .kinex/python PACKAGE` for driver dependencies. Host
shells remain generic; standalone supplies prompt guidance for explicitly selecting
core Python. Existing root environments are left untouched. Video encoding requires ffmpeg.
Neither dependency is needed just to import/discover the package.

## Development

From the repository root:

```sh
npm ci
npm run build:core    # Node ESM + declarations, including text modules
npm run test:core     # real Node tests and npm tarball installed outside the repo
npm run typecheck
npm test             # standalone regression suite
npm run build        # standalone, core and host adapters
```

Node loads `dist/`. Build the core before
packing it. No package is published by these commands. The standalone CLI and Pi
TUI also support Node 22.19 without OpenTUI FFI. This first delivery provides npm
tarballs; self-contained Node releases are deferred.

`@kinex/core/permission/index` exports rule validation and `kinexPermissionPolicy`
(defaults and always-allow stop) plus `kinexPermissionAction` for host adapters.
`loadTools(directory, {additionalTools, enableRecording})` composes the single core
catalog with host tools; recording is omitted unless explicitly enabled. Host tools
and core builtins precede discovered custom tools, with conflicts reported.
