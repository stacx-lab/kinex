# Project overview

The operational ROS contract is described in [communication](communication.md).

Kinex composes a robotics runtime and optional setup features with a Pi-powered
standalone agent. For the device, tool and skill abstractions, start with
[architecture](architecture.md). Paths in the ownership table are relative to the
repository root.

## Ownership and composition

| Location | Owns |
| --- | --- |
| `packages/core` | Device management, ROS communication and supervision, schemas, runtime Python, `kinex_interfaces`, operational tools, setup-device and device guides with reference nodes. No setup, agent or UI dependency. |
| `packages/setup` | Onboarding and calibration workflows, tools, skills and evidence. Device preparation, including ROS, uses core's setup-device. Imports core through package exports. |
| `src`, `src/integration` | Standalone CLI, storage, product policy, Kinex tool rendering and bundled Pi extensions. Published Pi SDKs supply providers, coding tools, agent loops and TUI. |
| `../kinex-plugins` | Plugins for Pi, Claude Code and Codex using a shared MCP adapter and explicit packed core/setup snapshots. |

`KinexContribution` exposes tools, skills, commands and namespaced context. Hosts
compose contributions explicitly; new interaction or lifecycle semantics need
host adaptation. Standalone selects an `ApplicationComposition` before runtime
creation, carrying roots, reservations and factories across workspace/session
changes. Defaults include setup; custom compositions replace those defaults.
Duplicate contribution identifiers are errors.

Core alone can provision, register, remove and operate devices. Setup borrows its
runtime through tracked operations and tool execution, sharing cancellation,
permissions and recording attribution without a separate resource lifecycle.
Registration leaves devices unloaded. The model's `profile_write` tool preserves
activation intent; trusted host profile APIs can write it directly. Core owns
readiness facts; setup owns procedures that obtain them.

## Runtime, discovery and lifecycle

Construction is inert. Bound operations share a workspace resource scope;
`warmLoaded()` reserves initialization lanes. Runtimes isolate memory while disk
state belongs to the workspace. Disposal cancels and waits for tracked work,
finalizes recordings and releases owned processes through the core process helper.
Borrowed services are never terminated.

The nearest `.kinex/` directory owns the workspace's `workspace.yaml` assembly
and `devices/<name>/` inventory, each a `profile.yaml` with its node sources and
URDFs. It also holds `lib/` for Python shared by exec, tools and nodes,
`kinex.json` configuration, the `python/` environment and `recordings/`. Without
one, the workspace path is `<working-directory>/.kinex`; reads do not create it.
Reusable content discovery searches nearest project → ancestors → global →
packaged assets, with concrete device provisioning instances before type
templates. Read-only discovery must not create a nearer workspace or initialize
Python.

Custom tools use `.kinex/tools/`: Python tools occupy
`<name>/{tool.yaml,tool.py}`, and JS/TS tools live directly in that directory.
Custom skills use `.kinex/skills/<name>/SKILL.md`, searched recursively. Device
guides use `.kinex/device/<name>/DEVICE.md` for instances and
`.kinex/device/templates/<type>/DEVICE.md` for types. Global configuration uses
the same `tools/`, `skills/` and `device/` directories. Packaged assets use their
internal `builtin/tool`, `builtin/skill` and `builtin/device` paths.
Ordinary scripts passed to `exec` need no discovery entry or manifest.

Core lazily prepares `.kinex/python`: uv for non-ROS workspaces, or independent
Pixi/RoboStack Jazzy when workspace configuration selects `ros-jazzy`. Exec,
helpers, ROS clients, tf2 and recording use Kinex Python, independent of device
load state. Only device processes may select separate SDK interpreters.
Concurrent first use waits for preparation; incomplete bootstraps retry. Existing
prepared environments run without synchronization until their interface sources
change; `python.prepare()` explicitly synchronizes dependencies and rebuilds
interfaces from clean. Host shells retain their environment. The `kinex` root and
`kinex.helpers` form the exec API, which reaches devices only through
`kinex.communication`; `kinex.node` serves device nodes, `kinex.lib` holds shared
internals and `kinex.host` the processes the runtime launches.

User commands and permission-checked model tools control lifecycle; Python tools
cannot. The host records the devices each Python invocation commands: a failed,
timed-out or cancelled invocation stops them, and a device stop cancels the
invocations that commanded it (see
[commands and cleanup](communication.md#commands-and-cleanup)). `loaded` is
intent, not readiness; ordinary calls never restart failed services. Lifecycle
transitions fence resource users before releasing connections.
Unregister holds that fence through deactivation and deletion, works on unloaded
devices without starting nodes, and preserves files on required cleanup failure.
Shared URDF parsing allows caller-local cancellation; disposal cancels the parser.

See the [core runtime API](../packages/core/README.md#public-runtime) and
[setup composition API](../packages/setup/README.md#composition) for interfaces.

[Design index](README.md)
