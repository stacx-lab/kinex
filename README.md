<p align="center">
  <img src="assets/kinex-logo-text-day.svg#gh-light-mode-only" alt="Kinex" height="100">
  <img src="assets/kinex-logo-text-night.svg#gh-dark-mode-only" alt="Kinex" height="100">
</p>

<p align="center">
  <a href="https://github.com/stacx-lab/kinex/releases">
    <img src="https://img.shields.io/github/v/release/stacx-lab/kinex?style=flat-square&amp;label=release&amp;color=2563eb" alt="Latest release" height="20">
  </a>
  <a href="https://github.com/stacx-lab/kinex/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/stacx-lab/kinex/ci.yml?branch=main&amp;style=flat-square&amp;label=CI" alt="CI status on main" height="20">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License: Apache 2.0" height="20">
  </a>
  <a href="#getting-started">
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-339933?style=flat-square&amp;logo=node.js&amp;logoColor=white" alt="Node.js ≥22.19" height="20">
  </a>
  <a href="#getting-started">
    <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-555555?style=flat-square" alt="Platforms: Linux and macOS" height="20">
  </a>
</p>

<p align="center">
  <a href="https://stacx-lab.github.io/kinex/docs/">Documentation</a> ·
  <a href="#news">News</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#use-kinex-with-simulators">Simulators</a> ·
  <a href="#use-kinex-with-real-world-robots">Real-World Robots</a> ·
  <a href="#disclaimer">Disclaimer</a> ·
  <a href="#kinex-and-the-pi-ecosystem">Pi Ecosystem</a> ·
  <a href="#using-kinex-with-other-harnesses">Other Harnesses</a>
</p>

Kinex is a robotics harness for coding agents, built on the published Pi SDK.
Its three layers—**devices**, **tools**, and **skills**—provide environment access,
executable operations, and task guidance.

Read the [documentation website](https://stacx-lab.github.io/kinex/docs/) for
setup guides, concepts and command references.

<p align="center">
  <img src="assets/architecture.svg" alt="Kinex architecture: agents load skills and call tools or devices, whose nodes connect to hardware, simulators and services." width="640">
</p>

## News

- **2026.10.15**: Kinex v1.0.0 is released! Visit the [project website](https://stacx-lab.github.io/kinex/).

## Getting Started

Install on Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/stacx-lab/kinex/main/install.sh | bash
```

The installer reuses Node.js ≥22.19 and npm, or offers to install them if needed.
Follow any PATH instructions it prints, then start Kinex in your project:

```sh
cd /path/to/project
kinex
```

Use `/login` to connect a model provider and `/model` to choose a model.
Python execution uses a workspace-owned environment: uv for non-ROS workspaces,
or independent Pixi/RoboStack Jazzy for ROS. Exec, helpers and recording share
Kinex Python; device SDK interpreters are optional overrides for device nodes only.
See [environment setup](docs/communication.md#kinex-python).

You can also run a single task, resume a session, or update from the shell:

```sh
kinex "Inspect the workspace"          # Start with a prompt
kinex run "/ping left_arm"             # Run once without a model
kinex run "Describe the scene"         # Run a task and exit; -p also works
kinex --continue                       # Resume the latest project session
kinex --resume                         # Choose a previous session
kinex --model provider/model           # Start with a selected model
kinex update                           # Update Kinex and its bundled Pi SDK
kinex --help                           # All commands and options
```

See the [command reference](https://stacx-lab.github.io/kinex/docs/slash-commands/)
for in-session commands.

## Use Kinex with Simulators

Kinex 2.0 uses typed ROS topics and services. The sibling `rosbridge` checkout
provides a LIBERO simulator node and an offline device catalog. Start rosbridge
separately, then export `libero/panda` into a workspace and load its forwarding
devices. The workspace profile contains device facts and endpoints; execution
mode belongs to the externally launched world.

See [ROS communication](docs/communication.md) for the operation and Python
contracts. The sibling `workspace_libero/README.md` provides build, launch and
validation commands, including stepped and realtime runs. Its finite demo uses
a persistent deterministic model device, two cameras and independent control
and inference loops.

## Use Kinex with Real-World Robots

Open Kinex in your robot workspace and describe your hardware, how it connects,
and the task you want to perform:

```text
/onboarding Set up my robot arm, gripper, and overhead camera to pick objects from the table.
```

Onboarding helps connect devices and prepare the task's prerequisites, reusing
existing profiles and calibration. Use `/devices` to inspect the workspace,
`/load <device>` to connect an inactive device, and `/ping all` to check connections.
If the task needs additional calibration, request its scope, for example
`/calibrate camera-to-arm transform for picking`.

Once ready, give Kinex the task in plain language. Use `/stop` to cancel the
response and stop actuators within their declared scope, or `/unload <device>`
to release a device. See [onboarding and calibration](https://stacx-lab.github.io/kinex/docs/onboarding/)
for more detail.

## Disclaimer

Kinex is provided "AS IS", without warranties, under the [Apache License 2.0](LICENSE).
Users are responsible for safe operation. Always supervise real robots, keep a
physical emergency stop within reach, and verify motion limits before running
tasks. Software commands such as `/stop` do not replace a hardware emergency stop.

## Kinex and the Pi Ecosystem

Kinex is built on [Pi](https://pi.dev) and supports Pi plugins: extensions,
skills, prompt templates and themes. Install packages from npm, Git or a local
folder using the same package format.

Kinex includes [pi-web-search](https://www.npmjs.com/package/pi-web-search) for web
search and [pi-btw](https://www.npmjs.com/package/pi-btw) for side conversations.
You can also bring your own Pi skills, prompts and themes.

```sh
kinex install npm:pi-web-search         # Override the bundled version
kinex install ./my-pi-package -l        # Add a package to this project
kinex list                             # Show installed and bundled packages
kinex update --extensions              # Update packages, preserving version pins
kinex remove npm:pi-web-search          # Restore the bundled fallback
```

Installs default to user scope; `-l` selects the project. Restart after changing
packages. Browse [Pi packages](https://pi.dev/packages) or read the
[package documentation](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md).

## Using Kinex with Other Harnesses

Kinex plugins currently support **Pi, Claude Code and Codex**. They package Kinex's
device tools, skills and robot context through a shared MCP adapter, with Pi also
providing direct lifecycle commands and UI integration. They are maintained in the separate
[kinex-plugins repository](https://github.com/stacx-lab/kinex-plugins).
OpenCode is not currently supported.

Choose your harness there, follow its installation and configuration instructions,
then open your robot workspace in that harness and explicitly request “Start
Kinex.” Use “Show Kinex status” to inspect the runtime and “End Kinex” to release
devices while keeping the host open. Pi also provides `/kinex-start`,
`/kinex-status` and `/kinex-end` as direct commands.

Plugins retain the host's coding workflow and use host-managed approvals by
default; standalone Kinex is not required. Plugin releases and their bundled
core/setup snapshots are updated independently.

## Contributing & Development

Issues and pull requests are welcome. Read [AGENTS.md](AGENTS.md) for contribution
rules, [architecture](https://stacx-lab.github.io/kinex/docs/architecture/#packages)
for package boundaries, and [runtime documentation](https://stacx-lab.github.io/kinex/docs/runtime/)
for workspace discovery and resource lifecycle.
The [device](https://stacx-lab.github.io/kinex/docs/devices/) and
[onboarding](https://stacx-lab.github.io/kinex/docs/onboarding/) guides cover
device control, setup and calibration.

For source development:

```sh
git clone https://github.com/stacx-lab/kinex.git
cd kinex
nvm use
npm ci
npm run build
npm run dev
```

Before submitting code changes, install the Python test dependencies and run the
full check (Node ≥22.19, Python 3 and a POSIX host):

```sh
python3 -m pip install -r packages/core/test/requirements.txt -r packages/setup/test/requirements.txt
npm run check
```

The check builds once and covers core, setup, standalone, PTY and packed consumers.
Do not rebuild packages while consumer tests run. Documentation-only edits need
link and diff checks. [Native ROS checks](packages/setup/test/container/README.md)
run separately.

## Acknowledgements

Kinex builds on [Pi](https://github.com/earendil-works/pi). Its published SDKs
provide the model integrations, coding tools, agent loop, session management and
terminal UI. Thanks to the Pi maintainers and community for the foundation and
plugin ecosystem that make Kinex possible.

## License

Kinex is licensed under the [Apache License, Version 2.0](LICENSE).

Third-party components retain their own licenses. See
[third-party notices](THIRD_PARTY_NOTICES.txt) for Pi's MIT license and attribution.
