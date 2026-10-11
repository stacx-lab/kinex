# Project overview

Kinex composes a robotics runtime and optional setup features with a Pi-powered
standalone agent. For the device, tool and skill abstractions, start with
[architecture](architecture.md). Paths in the ownership table are relative to the
repository root.

## Ownership and composition

| Location | Owns |
| --- | --- |
| `packages/core` | Device management, non-ROS provisioning, schemas, runtime Python, operational tools, setup-device and device guides. No setup, ROS, agent or UI dependency. |
| `packages/setup` | Onboarding, calibration, ROS provisioning/adapters and dependency checks. Imports core through package exports. |
| `src`, `src/integration` | Standalone CLI, storage and product policy. Published Pi SDKs supply providers, coding tools, agent loops and TUI. |
| `../kinex-plugins` | Separate native Pi, OpenCode and Codex integrations consuming explicit packed core snapshots. |

`KinexContribution` exposes tools, skills, commands and namespaced context. Hosts
compose contributions explicitly; new interaction or lifecycle semantics need
host adaptation. Standalone selects an `ApplicationComposition` before runtime
creation, carrying roots, reservations and factories across workspace/session
changes. Defaults include setup; custom compositions replace those defaults.
Duplicate contribution identifiers are errors.

Core alone can provision, register, remove and operate devices. Setup borrows its
runtime through tracked operations and tool execution, sharing cancellation,
permissions and recording attribution without a separate resource lifecycle.
Registration leaves devices unloaded. Profile writes cannot change activation
intent. Core owns readiness facts; setup owns procedures that obtain them.

## Runtime, discovery and lifecycle

Construction is inert. Bound operations share a workspace resource scope;
`warmLoaded()` reserves initialization lanes. Runtimes isolate memory while disk
state belongs to the workspace. Disposal cancels and waits for tracked work,
finalizes recordings and releases owned processes through the core process helper.
Borrowed services are never terminated.

`.kinex/workspace.yaml` describes the assembly; `devices/<name>/profile.yaml`
defines inventory. Discovery precedence is nearest project → ancestors → global →
packaged assets, with concrete instances before type templates. Read-only discovery
must not create a nearer workspace or initialize Python.

Core prepares `.kinex/python` with uv only when its interpreter is missing.
Concurrent first use waits for preparation to finish. Existing environments run
without dependency synchronization; repair is explicit. Explicit interpreters own
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
