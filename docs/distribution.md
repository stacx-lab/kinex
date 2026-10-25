# Installation and releases

## Installation

Follow [Getting Started](../README.md#getting-started). The installer requires
Node >=22.19 and npm, offering to install them interactively when missing. It
verifies matching release archives, installs under the Kinex data directory and
creates `~/.local/bin/kinex`. PATH changes require confirmation.

## Updates

| Command | Updates |
| --- | --- |
| `kinex update` | Kinex and its bundled Pi SDK. |
| `kinex update --extensions` | Installed packages, preserving pins. |
| `kinex update <source>` | One installed package. |
| `kinex update --all` | Kinex, then installed packages. |

Self-update handles npm release installations, including the installer's prefix,
global npm installs and local projects with a direct Kinex dependency. It rejects
source checkouts and linked installs with instructions to update and rebuild them.
The installer and Kinex self-update never downgrade a newer Kinex version. Failed
npm installs report recovery commands.

## Releases and validation

Core, setup and standalone share a version with exact internal dependencies.
Plugins for Pi, Claude Code and Codex release independently in
[kinex-plugins](https://github.com/stacx-lab/kinex-plugins) and consume checksummed
core/setup snapshots.
Release archives include SHA-256 checksums.

Core ships the `kinex_interfaces` ROS package (`Json`, `LookupTransform` and
`Wait` services). ROS workspaces build it into Kinex Python and rebuild it on next
use when an update changes its sources.
[rosbridge](https://github.com/stacx-lab/rosbridge) serves
`kinex_interfaces/srv/Wait` from its own identical copy, so it builds without a
Kinex checkout.

`npm run check` covers core, setup, standalone, PTY behavior and packed consumers.
See [development instructions](../README.md#contributing--development) for prerequisites.
[Native ROS checks](../packages/setup/test/container/README.md) run separately.

[Design index](README.md)
