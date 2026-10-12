# Agent integration and context

## Tools and device guidance

Tools declare schemas, capabilities and timeouts; composition preserves permissions
and recording attribution. Device guides own Setup, Profile and Use sections; only
Use enters loaded-device context. Custom instance `DEVICE.md` guides are allowed
only for `legged_base`, require nonempty Use text and override shared guides with
normal discovery precedence. Other types use shared guides and profile parameters.
Workspace safety limits and keep-out zones remain manifest data, outside robot
context; `safety.notes` is not a schema field.

## Sessions and permissions

Hosts own approval UI, session identity and cancellation, keeping trusted commands
separate from model calls. Missing permission callbacks deny except stop. Standalone
retains connections across same-workspace sessions while cancelling old calls,
resetting grants and ending recordings; workspace replacement/quit disposes them.
Robotics/question batches execute sequentially; denial/cancellation stops later
calls without rolling back completed work. Pure coding batches remain parallel.

`exec` requests `python_tool_controller` approval once for the script and its
composed runtime calls. Device reads and actions share that approval; composed
perception tools retain their capability restrictions. Python execution cannot
change device lifecycle or call the recording tool. Existing manifest tools keep
their permission behavior when invoked outside `exec`.

## Recording

Manual recording is available; model recording is opt-in. Native capture or dispatch
sampling produces manifests, timelines, profile snapshots and per-device products;
incidental traffic is separate. Acquisition timestamps, cadence and playback FPS
are distinct. Losses are counted, failures are per-device, finalization is bounded
and quotas permit limited overshoot. Hosts supply transcript references; outcome
labels are annotations, not verification.

## Context and compaction

Tools/skills refresh within tasks. Stable prompt prefixes exclude dynamic state;
changes append to the active branch. Compaction preserves robotics facts and
restores a full current snapshot before the next request, stopping if recovery
fails. Images enter history as bytes; recording traces omit image bytes and opaque
reasoning. Active time uses a monotonic clock, excludes idle/input dialogs and
persists outside model context; shutdown clears footer timers/subscriptions.

## Pi resources and credentials

Standalone uses Kinex storage and a managed auth link so SDK child sessions share
credentials and OAuth locks; conflicts are never overwritten. Pi owns `/reload`;
programmatic core `devices.reload()` remains available. Setup bundles upstream
web-search/BTW extensions, loaded through Pi with explicit packages taking
precedence. BTW children use upstream coding tools and credentials without Kinex
runtime or permission hooks. Package management uses Pi APIs without starting
sessions, loading extensions or initializing robotics. Project declarations live
under `.kinex/agent`, resources under `.pi`; version/ref pins survive updates.

See [project overview](overview.md) for contribution ownership and
[device contracts](devices.md) for driver lifecycle and capture interfaces.

[Design index](README.md)
