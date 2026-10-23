# Plan for Kinex2.0

## What is Kinex?

Kinex is a coding-agent harness for robotics: an agent can provision, inspect,
and control real hardware and simulators through shared device interfaces.

## Kinex1.0 design

Kinex1.0 (`../kinex`) uses three layers to separate fast basic operations,
reusable programmatic capabilities, and workflows that require agent reasoning:

- **Devices:** Abstract hardware and simulators into device types with common
  basic operations, such as reading and writing, that can run at high frequency.
- **Tools:** Combine devices and other tools into reusable capabilities, such as
  perception and control, that execute without agent involvement once invoked.
- **Skills:** Provide instructions for using devices and tools; the agent remains
  involved to interpret results, make decisions, and adapt the workflow.

The implementation separates three components:

- **Core (`@kinex/core`):** A host-independent robotics runtime for device
  lifecycle, drivers, perception, control, kinematics, recording, and Python tools.
- **Setup (`@kinex/setup`):** Optional onboarding and calibration, organized as
  a task-scoped dependency graph with recorded evidence.
- **Agent integration:** A standalone CLI built on the Pi SDK, which supplies
  the agent loop, model providers, sessions, and terminal UI. Separate native
  plugins reuse core in other coding agents.

Workspace-local `.kinex` files hold device profiles, drivers, tools, and state.
Core and setup expose tools, skills, commands, and context through a shared
contribution interface. The runtime manages validation, permissions, cancellation,
and resource cleanup; drivers adapt hardware and simulators to common contracts.

## What Kinex1.0 struggles with

1. **Robotics workloads are difficult to support cleanly.** Background services
   must react independently of agent turns: a safety kernel should monitor force
   and torque limits and preempt unsafe actions, while humanoids need continuous
   control to maintain balance and posture. Motor control, perception, and task
   planning also require different decision rates, which the architecture should
   let us coordinate explicitly.

2. **Workflow templates are too rigid.** Closed-loop execution repeatedly
   perceives, controls, and checks termination. Our `closed_loop` tool accepts
   functions through tool references or inline Python, but fixes their surrounding
   sequence and timing structure. We need to customize the workflow itself,
   including stage ordering, branching, and independent execution rates.

3. **Persistent computational services need a clear device representation.**
   A model service should retain its loaded model and resources across inference
   requests through the device lifecycle. Its nodes and operations expose its
   functions. Tools remain invocation-scoped consumers of these services; they
   do not need a separate persistent lifecycle.

4. **Low-level data clutters the model context.** In a read-arm-state →
   compute-target-pose → write-to-arm workflow, raw joint values and target poses
   pass through the context as high-precision floats. Device-to-device and
   tool-to-tool communication depends too heavily on the agent as an intermediary.
   We need flexible pipelines that preserve full precision between components
   while exposing relevant summaries or references to the agent.

## Plan for Kinex 2.0

### Communication through ROS 2

Use ROS 2 and `rclpy` for two communication modes:

- **Topics:** Asynchronous, many-to-many streams, such as camera frames, joint
  states, force/torque readings, and device commands.
- **Services:** Request-response operations, such as FK/IK computations and
  on-demand model inference. A perception request supplies an image and detection
  parameters; the response returns detections or poses.

Use ROS primarily as communication and execution infrastructure. Prefer standard
typed ROS messages where suitable, adding custom interfaces where necessary;
adopting unrelated ROS subsystems is not required. Do not introduce ROS actions.
Kinex workflows handle orchestration and termination in ordinary Python.

The design should support direct device-to-device communication without routing
data through the Kinex host. For example, a feedback loop between devices on one
machine should be able to remain on that machine. Advanced remote placement and
deployment automation may be deferred from the first version.

A camera with ten subscribers should capture and publish once per source tick,
rather than capture separately for each client. Bound subscriber queues so slow
consumers do not accumulate unlimited data. This does not imply constant network
bandwidth or zero-copy delivery as subscriber count increases.

Provide convenient communication helpers for both humans and agents. Preserve
full precision between components, exposing selected summaries, references, and
images to the agent instead of routing every intermediate value through context.

### Devices, profiles, and operations

Devices remain typed and accompanied by profiles, but their operations become
extensible:

1. A device can expose arbitrary operations through topics and services rather
   than being limited to fixed operations such as `read` and `write`.
2. Each operation has a short description of its function and a declared
   communication interface.
3. Device attributes and properties remain in the profile. Operations use those
   attributes as needed.
4. Each device provides four built-in operations: `load` starts its runtime;
   `unload` releases its resources; `status` observes readiness and returns a
   concise status; and `stop` invokes the device's declared stopping behavior.
   For an arm, stopping should normally switch to hold. Cleanup must not terminate
   borrowed services.
5. Agents can patch node definitions to add operations and inspect a compact
   operation catalog without rereading the full profile. Apply runtime-definition
   changes through unload, validation, and explicit reload.

A device may use one node for several operations or several nodes for different
operations. Its nodes persist according to the device lifecycle, independently
of individual tool invocations. Cameras can continuously publish frames, and
actuators can continuously listen for commands.

### Persistent services are devices; tools are invocation-scoped

Model services are devices whose nodes and operations provide their functions.
For example, loading a perception-model device loads its model once and exposes
a request-response detection service. Multiple tool invocations can call that
service. Unloading the device releases the model and GPU resources. Keeping the
model loaded does not require continuously running inference or publishing results.

Tools do not have a persistent lifecycle or background instances that survive
their invocation. They combine device operations and computation, then return.
A tool can run for several minutes and retain intermediate state while it runs;
invocation-scoped does not mean instantaneous.

Continuous acquisition, ongoing control, and services that must outlive a tool
invocation belong to devices and their nodes. A tool or `exec` workflow can compose
those persistent resources without acquiring its own persistent start/stop API.

### Python workflows and temporary resources

the exec tool can be reformed. it should be able to construct a workflow just in time
using rclpy and maybe other helpers. You have the freedom to define simplified grammars
other than rclpy if necessary. 

Temporary nodes, relays, subscriptions, and timers belong to the invocation that
creates them and are removed when it ends. Device nodes and model services retain
their separate device lifecycle. Reusable tools already in the library can remain,
adapted to the new device and communication contracts.

Use tf2 for live frame relationships and pose transformations. Keep calibration
measurements and fixed mounting facts in profiles, while device nodes publish the
corresponding transforms. if needed, tf2 topics should be published during device load. Missing frame relationships must not become identity
transforms.

### Permissions and motion cleanup

Simplify execution permissions by removing the separate perception/controller
permission distinction. One host approval authorizes a Python invocation and its
composed operations, without per-message prompts. This is execution approval, not
a sandbox for arbitrary Python.

Keep trusted lifecycle commands separate from permission-checked model tools.
Python tools cannot load or unload devices. Explicit device stop remains available
without approval, and model-controlled recording remains opt-in.

Successful execution preserves sent device motion. If stopping is intended,
the agent explicitly calls device stop, including stop-all. Removing temporary
workflow resources does not itself stop motion successfully submitted to a device.

Failure, timeout, and cancellation stop every device the failed execution
commanded, and a device stop cancels executions that commanded it. Device unload
and runtime disposal retain their resource and shutdown obligations.

### Package ownership and implementation scope

Core owns operational ROS 2/rclpy infrastructure, device communication, runtime
resources, and lifecycle supervision. Setup retains onboarding and calibration,
consuming core through package exports. Update the existing repository rule that
excludes ROS from core as part of implementing this new boundary. Core remains
independent of setup, host agents, and UI.

Preserve workspace discovery precedence, inert discovery, lazy `.kinex/python`,
and ordinary shell environments. ROS processes use explicitly configured
interpreters and overlays. Use the owned-process helper and never terminate
borrowed services.

1. Refactor the current `kinex2.0/` code without backward-compatibility
   requirements. Improve modularity and code hygiene while adapting bundled tools
   and setup to the new core contract. remove what is unnecessary. 
2. Update `../rosbridge`, focusing integration validation on LIBERO. Replace its
   motion-action integration with topics and services. Porting every existing
   hardware integration is not required for this first implementation.
3. Put the runnable demo in `../workspace_libero`. Plugin snapshot updates are
   outside this implementation.

### Demo and validation

The first LIBERO demo is a runtime/control demonstration, not a task-solving
policy. It must demonstrate operation discovery, topic streams, request-response
services, TF, independent workflow rates, observable robot motion, device
lifecycle, and temporary-resource cleanup. Demonstrate persistent computation
through a model device, not a persistent tool. Completing a LIBERO benchmark task
is not required.

Validate stepped and realtime execution, camera fan-out with bounded queues,
service failures and timeouts, successful-motion preservation, explicit stop-all,
commanded-device cleanup after failure or cancellation, and preservation of borrowed
services. Keep validation for permissions, recording ownership, calibration
evidence, and package independence as the implementation changes.

### rosbridge

rosbridge should tranform the libero in ros apis. I think you can use one single sim node
for all devices, and start corresponding services or topics; devices in the workspace 
use a dummay node, which forward the messages between kinex and sim node. Similar to RoboEnv, which used to write devices in catalog/robots/, you should also write device catalogs for libero, which will be copied to workspace_libero/.kinex/devices/. RoboEnv and rosbridge are similar in usage, one is for previous device-based api, the other is for today's ros based convension, and for workspace.yaml it should be simple, do not expose anywhere we are in simulation. 

look at other workspace demos `workspace_abc/` for how workspace should look likt (but note it 
is using old device-based convention)