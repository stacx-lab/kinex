# Installation and releases

## Installation

Follow [Getting Started](../README.md#getting-started). The installer requires
Node >=22.19 and npm, offering to install them interactively when missing. It
verifies matching release archives, installs under the Kinex data directory and
creates `~/.local/bin/kinex`. PATH changes require confirmation.

The installer asks the GitHub API for the latest stable release, which limits
anonymous requests by IP address. When the installer reports that limit, pass a
token through its environment; it is sent only to that request:

```sh
curl -fsSL https://raw.githubusercontent.com/stacx-lab/kinex/main/install.sh | GH_TOKEN=<token> bash
```

`GH_TOKEN` is read first and `GITHUB_TOKEN` when `GH_TOKEN` is unset; blank
values are ignored. The assignment belongs before `bash`: placed before `curl`,
it never reaches the installer. The token reaches `curl` on standard input, so
it appears in neither process listings nor the installer's output.

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

Core ships the `custom_interfaces` ROS package (`Json`, `LookupTransform` and
`Wait` services). ROS workspaces build it into Kinex Python and rebuild it on next
use when an update changes its sources.
[rosbridge](https://github.com/stacx-lab/rosbridge) serves `Wait` and `Json` from
its own identical copy of the package, so it builds without a Kinex checkout.

`npm run check` covers core, setup, standalone, PTY behavior and packed consumers.
See [development instructions](../README.md#contributing--development) for prerequisites.
[Native ROS checks](../packages/setup/test/container/README.md) run separately.

[Design index](README.md)
