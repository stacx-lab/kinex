# Agent integration and context

## Tools and device guidance

Tools declare input schemas; Python manifests also declare a timeout. Contribution
composition preserves permissions and recording attribution. Device templates own
setup guidance only, and agents read device and operation descriptions from
profiles; see [device contracts](devices.md#profiles).
Workspace keep-out zones remain manifest data, outside robot context.

`exec` is a core tool alongside direct device calls and reusable Python tools.
It runs source or script files in a fresh process, returning the printed output
and either an optional JSON-ready result or an error; an uncaught exception's
traceback appears once, in the error. Its optional `description` is the display
subject; standalone shows the highlighted inline source or the `python` command
beneath it, then the printed output followed by the result or the failure.
The host's shell and file tools retain their own execution paths and permissions.

Tool results can carry image attachments as `{mime, data}` (base64) or
`{mime, path}`. Hosts must forward both as image content in attachment order.
Direct camera reads attach their PNG, JPEG, GIF or WebP image automatically; Python
results attach selected image files returned through `finish`. A partially
successful `devices` batch retains successful images and per-call errors, with the
top-level error flag set only when every call failed. Hosts must inspect individual
results without discarding the successful observations.

## Sessions and permissions

Hosts own approval UI, session identity and cancellation, keeping trusted commands
separate from model calls. Missing permission callbacks deny; stop never asks. Standalone
retains connections across same-workspace sessions while cancelling old calls,
resetting grants and ending recordings; workspace replacement/quit disposes them.
Robotics/question batches execute sequentially; denial/cancellation stops later
calls without rolling back completed work. Pure coding batches remain parallel.
Standalone labels each user command result it adds to the conversation with the
command that produced it.

`exec` requests `python_tool` approval once per invocation; its device reads and
commands share that approval, and Python cannot change device lifecycle or control
recording. Manifest tools request their own `python_tool` approval per call; inside
`exec`, scripts call the matching helpers instead. A failed, timed-out or cancelled
invocation stops the devices it commanded, and a device stop cancels the invocations
that commanded it; see [commands and cleanup](communication.md#commands-and-cleanup).
Hosts route `exec` through core's tool API so the shared Python runner applies this
cleanup.

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
configured observation; continuous capture requires topic operations.

`devices/<name>/stream/bag/` holds the bag, `operations.json` its catalog, and
`samples.jsonl` the operation, acquisition stamp, world time, reset epoch and
receipt time for each recorded message. Full payloads stay in the bag rather than
crossing the host JSON channel. Bags use monotonic receipt order across world
resets; message stamps are unchanged. Ordinary host-observed requests/responses
retain invocation attribution separately. No automatic video transcoding occurs.

Queue losses and errors are counted. Rate-filtered output samples are counted
separately from losses. Unload/disposal finalize owned capture processes;
borrowed publishers remain running. Quotas permit limited overshoot. Hosts supply
transcript references; outcomes and summaries are annotations, not verification.

## Context and compaction

Tools/skills refresh within tasks. Stable prompt prefixes exclude dynamic state;
only changed minimal context sections append to the active history tail. Core's
stable robotics instructions cover the `.kinex` workspace layout, devices, Python,
principles and tools; setup adds where its plans and calibration attempts live.
Device catalogs, readiness and ROS payload schemas are queried inside exec
through `kinex.runtime`, never injected into the stable prefix or model tool list.
Exec instructions and examples are workspace-independent. Compaction restores
the same minimal sections before the next request, stopping if recovery fails.
Images enter history as bytes; recording traces keep only conversation messages,
omitting system entries, image bytes and opaque reasoning. Active time uses a
monotonic clock, excludes idle/input dialogs and persists outside model context;
shutdown clears footer timers/subscriptions.

## Pi resources and credentials

Standalone uses Kinex storage and a managed auth link so SDK child sessions share
credentials and OAuth locks; conflicts are never overwritten. Pi owns `/reload`;
programmatic core `devices.reload()` remains available. Standalone bundles upstream
web-search/BTW extensions, loaded through Pi with explicit packages taking
precedence. BTW children use upstream coding tools and credentials without Kinex
runtime or permission hooks. Package management uses Pi APIs without starting
sessions, loading extensions or initializing robotics. Project declarations live
under `.kinex/agent`, resources under `.pi`; version/ref pins survive updates.

See [project overview](overview.md) for contribution ownership and
[device contracts](devices.md) for node lifecycle and observation interfaces.

[Design index](README.md)
