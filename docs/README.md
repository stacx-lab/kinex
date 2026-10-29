# Documentation

For usage, start with the [project README](../README.md) and
[command reference](commands.md). The design documents below describe
Kinex's abstractions, package boundaries and runtime contracts; start with
architecture, then read the topics relevant to your change.

| Topic | Covers |
| --- | --- |
| [Architecture](architecture.md) | Devices, tools and skills, and their connections to agents and environments. |
| [ROS communication](communication.md) | Device definitions, Kinex Python, async pub/sub and services, world timing, commands and cleanup, tf2 and camera frames. |
| [Project overview](overview.md) | Package ownership, composition, workspace layout, discovery, Kinex Python and resource lifecycle. |
| [Device contracts](devices.md) | Types, profiles, device nodes, frames, commands and stop, world clocks, models, end effectors, locomotion, cameras and sensors. |
| [Tools and skills](tools-and-skills.md) | Built-in tools, Python execution with `exec`, feedback loops and setup-device. |
| [Setup, calibration and ROS](setup.md) | Task prerequisites, calibration evidence, ROS configuration and dependencies. |
| [Agent integration and context](agent-integration.md) | Tools, device guidance, permissions, sessions, recording, compaction and Pi resources. |
| [Installation and releases](distribution.md) | Package versions, the curl installer, upgrades, ROS interfaces and validation. |

For API details and examples, see [core](../packages/core/README.md) and
[setup](../packages/setup/README.md). Design history and progress belong in git.
