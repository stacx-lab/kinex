# Agent integration and context

## Tools and device guidance

Tools declare input schemas; Python manifests also declare capability kind and
timeout. Composition preserves permissions and recording attribution. Device
guides own Setup, Profile and Use sections; only
Use enters loaded-device context. Custom instance `DEVICE.md` guides are allowed
only for `legged_base`, require nonempty Use text and override shared guides with
normal discovery precedence. Other types use shared guides and profile parameters.
Workspace safety limits and keep-out zones remain manifest data, outside robot
context; `safety.notes` is not a schema field.

`exec` is a core tool alongside direct device calls and reusable Python tools.
It runs source or script files in a fresh process, returning captured stdout/stderr,
an exit code and an optional structured result. Its optional `description` is a
display label; standalone falls back to the script path or `python script`.
The host's shell and file tools retain their own execution paths and permissions.

Tool results can carry image attachments as `{mime, data}` (base64) or
`{mime, path}`. Hosts must forward both as image content in attachment order.
Direct camera reads attach RGB images automatically; Python results attach
selected image files returned through `finish`. A partially successful `devices`
batch retains successful images and per-call errors, with the top-level error
flag set only when every call failed. Hosts must inspect individual results
without discarding the successful observations.

## Sessions and permissions

Hosts own approval UI, session identity and cancellation, keeping trusted commands
separate from model calls. Missing permission callbacks deny except stop. Standalone
retains connections across same-workspace sessions while cancelling old calls,
resetting grants and ending recordings; workspace replacement/quit disposes them.
Robotics/question batches execute sequentially; denial/cancellation stops later
calls without rolling back completed work. Pure coding batches remain parallel.

`exec` requests `python_tool` approval once for the script and its
composed runtime calls. Device reads and actions share that approval; composed
Python tools share the same execution scope. Python's runtime API cannot
change device lifecycle or call the recording tool. Existing manifest tools keep
their permission behavior when invoked outside `exec`.

Scripts and composed tools share cancellation and motion ownership. On controller
failure, timeout or cancellation, the runner attempts to stop motion they still
own and terminates owned subprocesses. Cleanup failures are logged while the
original failure is returned. Normal script completion does not imply a stop:
scripts use `stop_owned()` when their stopping condition requires one. Ownership
checks preserve replacements, subject to the driver's physical stop scope.
These behaviors use the shared Python runner; hosts should route `exec` through
core's tool API. Per-entry errors
in a Python `devices()` result do not by themselves fail the script; scripts must
inspect them and decide whether to stop or raise an error.

## Recording

Manual recording is available; model recording is opt-in. Continuous capture
observes declared topic operations in a separate owned process. It saves rosbag2
SQLite/CDR bags with full typed payloads, including image/depth streams, plus
manifests, timelines, profile snapshots and a per-sample index. The world clock
and TF topics accompany each device bag. Output rates are capped in world time;
input commands and frame/clock data are not rate-filtered. Recording never calls
world waits or advances simulation. Paused time produces no repeated frames.

`recording.start({specs: {arm: {rate: 10, operations: ["joint_state", "joint_target"]}},
sessionID})` selects operations; omitting `operations` captures all declared
topics. Service-only devices can be captured with explicit snapshots using their
configured observation. Old direct drivers support snapshots and passive host
events; continuous capture requires topic operations.

`devices/<name>/stream/bag/` holds the bag, `operations.json` its catalog, and
`samples.jsonl` the operation, acquisition stamp, world time, reset epoch and
receipt time for each recorded message. Full payloads stay in the bag rather than
crossing the host JSON channel. Bags use monotonic receipt order across world
resets; message stamps are unchanged. Ordinary host-observed requests/responses
retain invocation attribution separately. No automatic video transcoding occurs.

Queue losses and errors are counted. Rate-filtered output samples are counted
separately from losses. Unload/disposal finalize owned capture processes;
borrowed publishers remain running. Quotas permit limited overshoot. Hosts supply
transcript references; outcome labels are annotations, not verification.

## Context and compaction

Tools/skills refresh within tasks. Stable prompt prefixes exclude dynamic state;
only changed minimal context sections append to the active history tail. Device
catalogs, readiness summaries and ROS payload schemas are queried inside exec
through `kinex.runtime`, never injected into the stable prefix or model tool list.
Exec instructions and examples are workspace-independent. Compaction restores
the same minimal sections before the next request, stopping if recovery fails. Images enter history as bytes; recording traces omit image bytes and opaque
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
