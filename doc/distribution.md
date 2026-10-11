# Installation and releases

## Package releases

Core, setup and standalone release aligned versions with exact internal dependencies
and Node >=22.19. Standalone uses Pi SDK 1.1.0; native plugins own independent
versions, SDKs and host glue, consuming checksummed core snapshots with provenance.

## Installation and upgrades

The root `install.sh` reuses Node >=22.19 and npm or asks to install them through
Homebrew, suitable apt/apk packages, or a verified official Node binary. Without
a terminal, missing prerequisites require manual preparation. Standalone Node lives
under the Kinex data directory and is added to PATH by the installed launcher.

The installer verifies all three matching GitHub release archives before installing
them as direct npm dependencies under the data directory's `install/`. Its
`~/.local/bin/kinex` launcher preserves other installations; PATH configuration
changes require confirmation. Archives remain under `releases/<version>/` for npm
file references. Self-upgrade recognizes this direct npm installation; source and
linked installs stay unchanged. Neither installation nor upgrade downgrades a newer
version. npm failure can leave a partial installation and reports recovery commands.

## Validation

CI checks core, setup, standalone, PTY behavior and relocated packed consumers.

See [Getting Started](../README.md#getting-started) for installation and
[Contributing & Development](../README.md#contributing--development) for checks
and release commands.

[Design index](README.md)
