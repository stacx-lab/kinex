# Project overview

Kinex composes a robotics runtime and optional setup features with a Pi-powered
standalone agent. For the device, tool and skill abstractions, start with
[architecture](architecture.md). Paths in the ownership table are relative to the
repository root.

## Ownership and composition

| Location | Owns |
| --- | --- |
| `packages/core` | Device management, non-ROS provisioning, schemas, runtime Python, operational tools, setup-device and device guides. No setup, ROS, agent or UI dependency. |
| `packages/setup` | Onboarding, calibration, ROS configuration and adapters. Imports core through package exports. |
| `src`, `src/integration` | Standalone CLI, storage and product policy. Published Pi SDKs supply providers, coding tools, agent loops and TUI. |
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
and `devices/<name>/profile.yaml` inventory. Without one, the workspace path is
`<working-directory>/.kinex`; reads do not create it. Reusable content discovery
searches nearest project → ancestors → global → packaged assets, with concrete
device provisioning instances before type templates. Read-only discovery must
not create a nearer workspace or initialize Python.

Custom tools use `.kinex/tools/`: Python tools occupy
`<name>/{tool.yaml,tool.py}`, and JS/TS tools live directly in that directory.
Custom skills use `.kinex/skills/<name>/SKILL.md`, searched recursively. Global
configuration uses the same plural `tools/` and `skills/` directories. Move custom
content from the old singular directories to these discovery roots. Packaged
assets retain their internal `builtin/tool` and `builtin/skill` paths.
Ordinary scripts passed to `exec` need no discovery entry or manifest.

Core prepares `.kinex/python` with uv when its interpreter is missing, and retries
incomplete bootstraps remembered by the current process. Concurrent first use
waits for preparation to finish. Existing environments run without dependency
synchronization; repair is explicit. Explicit interpreters own
their dependencies. Ordinary host shells retain their environment.

User commands and permission-checked model tools control lifecycle; Python tools
cannot. `loaded` is intent, not readiness; ordinary calls never restart failed
services. Lifecycle transitions fence resource users before releasing connections.
Unregister holds that fence through deactivation and deletion, works on unloaded
devices without starting drivers, and preserves files on required cleanup failure.
Shared URDF parsing allows caller-local cancellation; disposal cancels the parser.

See the [core runtime API](../packages/core/README.md#public-runtime) and
[setup composition API](../packages/setup/README.md#composition) for interfaces.

[Design index](README.md)
