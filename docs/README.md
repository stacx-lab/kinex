# Documentation

For usage, start with the [project README](../README.md) and
[in-session command reference](commands.md). The design documents below describe
Kinex's package boundaries and runtime contracts; start with architecture, then
read the topics relevant to your change.

| Topic | Covers |
| --- | --- |
| [Architecture and runtime](architecture.md) | Package ownership, composition, discovery, Python and resource lifecycle. |
| [Devices, motion and recording](devices.md) | Drivers, action buffers, stop ownership, world clocks, observations and recording. |
| [Frames, kinematics and control](control.md) | Frame conventions, IK, trajectory planning and feedback loops. |
| [Setup, calibration and ROS](setup.md) | Task prerequisites, calibration evidence, provisioning generations and dependencies. |
| [Agent integration and context](agent-integration.md) | Tools, device guidance, permissions, sessions, compaction and Pi resources. |
| [Installation and releases](distribution.md) | Package versions, the curl installer, upgrades and validation. |

For usage and development commands, see the [project README](../README.md).
For API details and examples, see [core](../packages/core/README.md) and
[setup](../packages/setup/README.md). Design history and progress belong in git.
