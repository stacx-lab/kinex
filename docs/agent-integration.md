# Agent integration and context

## Tools and device guidance

Tools declare input schemas. Contribution
composition preserves permissions and recording attribution. Device templates own
setup guidance only, and agents read device and operation descriptions from
profiles; see [device contracts](devices.md#profiles).
Workspace keep-out zones remain manifest data, outside robot context.

`exec` is a core tool alongside direct device calls. It runs a complete program,
given as source or as a file, in a fresh process, returning the printed output and
either the JSON-ready result the program finished with or an error; an uncaught
exception's traceback appears once, in the error. Its optional `description` is
the display subject; standalone shows the highlighted inline source or the file
beneath it, then the printed output followed by the result or the failure. `lib`
is read-only and asks no permission: it returns one module or function of the
function library per call, read from source without starting Python.
The host's shell and file tools retain their own execution paths and permissions.

Tool results can carry image attachments as `{mime, data}` (base64) or
`{mime, path}`. Hosts must forward both as image content in attachment order.
Direct camera reads attach their PNG, JPEG, GIF or WebP image automatically; exec
attaches only the images its program names in `finish(..., file=[...])`. A partially
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

A tool asks for the permission `unattended` before work that goes on with nobody
to approve its steps. Standalone shows the user its description and asks once,
also in `auto` mode; from `ask` the approval moves the session to `auto`. `yolo`
does not ask, and without a user only a session that already works without
approvals may go on. [Self-improvement](self-improve.md#roles) has its plan
approved this way.

`exec` requests `python_tool` approval once per invocation; its device reads and
commands share that approval, and Python cannot change device lifecycle or control
recording. Library functions run inside that invocation and add no approval of
their own; the user's `/exec` command is its own approval. A failed, timed-out or cancelled
invocation stops the devices it commanded, and a device stop cancels the invocations
that commanded it; see [commands and cleanup](communication.md#commands-and-cleanup).
Hosts route `exec` through core's tool API so the Python runner applies this
cleanup.

A program's `subagent` call is a host capability, `host.subagent(request, signal)`
in the runtime options: core passes the instruction, the shown text and image files
and an optional model name, and takes back the reply and the model that gave it.
Core never calls a model. The call is covered by the invocation's approval, is
aborted with it, and gives the subagent no tools. A host without the capability
leaves it unset and programs receive `subagent_unavailable`.

## Recording

Manual recording is available; model recording is opt-in. Continuous capture
observes declared topic operations in a separate owned process for each device,
plus one for the domain's world clock and TF, which every device's observations
are read against. It saves manifests, timelines, profile snapshots, a per-sample
index and each kind of data in the form that suits it:

| Data | Stored as | |
|---|---|---|
| 8-bit color images (`rgb8`, `bgr8`, `rgba8`, `bgra8`, `mono8`) | H.264 video, `stream/<operation>.mp4` | lossy; two to three orders smaller than the pixels |
| Depth and other images | typed messages in the bag | lossless; a 16-bit depth frame keeps under a third of its size |
| Joint states and commands, grippers, IMU, wrenches, odometry | typed messages in the bag | lossless |
| World clock and TF | typed messages in `tf/bag/` | once for all devices |

Bags are rosbag2 MCAP with zstd chunks and CDR messages; an environment without
the MCAP plugin writes SQLite, and `stream.storage` in the manifest names which.
Output rates are capped in world time; input commands and frame/clock data are
not rate-filtered. Recording never calls world waits or advances simulation.
Paused time produces no repeated frames.

`recording.start({specs: {arm: {rate: 10}}, sessionID})` captures all of a
device's declared topics at one rate. `operations` as a list selects operations:
`{rate: 10, operations: ["joint_state", "joint_target"]}`. As a map it gives an
operation its own rate or format, `{rate: 10, operations: {depth: 2}}`, and
selects only when the device has no rate: `{operations: {image: 10, depth: {rate: 2}}}`.
The format of an operation is `"video"` or `"bag"`: `{image: {rate: 10, format: "bag"}}`
keeps a color stream's exact pixels, as calibration needs. Without one, an image
operation goes to video when its frames are 8-bit color and `ffmpeg` is present,
and to the bag otherwise. The manifest's `sampling` records each operation's rate
in `rates` and the formats asked for in `formats`. Service-only devices can be
captured with explicit snapshots using their configured observation; continuous
capture requires topic operations.

`devices/<name>/stream/bag/` holds the bag, `operations.json` its catalog, and
`samples.jsonl` the operation, acquisition stamp, world time, reset epoch and
receipt time for each recorded message, with the `file` and `frame` of one stored
as video. A video holds its frames in arrival order at a nominal rate, as
fragmented MP4 that stays readable if capture dies; read a frame's time from
the index, never from the video's timeline. A frame of another size or encoding
starts the operation's next file, `<operation>.1.mp4`. Full payloads stay in the
bag or video rather than crossing the host JSON channel. Bags use monotonic
receipt order across world resets; message stamps are unchanged. Ordinary
host-observed requests/responses retain invocation attribution separately.

Queue losses and errors are counted. Rate-filtered output samples are counted
separately from losses. Unload/disposal finalize owned capture processes;
borrowed publishers remain running. Quotas permit limited overshoot. Hosts supply
transcript references; outcomes and summaries are annotations, not verification.

## Context and compaction

Tools/skills refresh within tasks. Stable prompt prefixes exclude dynamic state;
only changed minimal context sections append to the active history tail. Core's
stable robotics instructions cover the `.kinex` workspace layout, devices, Python,
principles and tools; setup adds none, as its tools, workflows and skills carry
their own guidance.
The device catalog, each operation's description and ROS interface, is the
`core.devices` context section; it changes only with profiles, not with load state,
and never enters the stable prefix or the model tool list. Readiness is the device
tool's `status`.
An installed self-improve brief is a context section, never part of the stable
prefix ([self-improvement](self-improve.md#libraries)).
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
