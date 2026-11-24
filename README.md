<p align="center">
  <img src="assets/banner-day.svg#gh-light-mode-only" alt="Kinex: a robotics harness for coding agents." width="100%">
  <img src="assets/banner-night.svg#gh-dark-mode-only" alt="Kinex: a robotics harness for coding agents." width="100%">
</p>

<p align="center">
  <strong>Kinex</strong> is an open-source robotics harness for coding agents, built on the published Pi SDK.
</p>

<p align="center">
  <a href="https://github.com/stacx-lab/kinex/releases"><img src="https://img.shields.io/github/v/release/stacx-lab/kinex?style=for-the-badge&amp;label=release&amp;color=756EE4&amp;labelColor=272B34" alt="Latest release"></a>
  <a href="https://stacx-lab.github.io/kinex/docs/"><img src="https://img.shields.io/badge/docs-read%20the%20guide-2B8AD6?style=for-the-badge&amp;labelColor=272B34" alt="Read the documentation"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-17A07A?style=for-the-badge&amp;labelColor=272B34" alt="License: Apache 2.0"></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/node-%E2%89%A5%2022.19-D2851C?style=for-the-badge&amp;logo=nodedotjs&amp;logoColor=white&amp;labelColor=272B34" alt="Node.js ≥22.19"></a>
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="#environments">Environments</a> ·
  <a href="#ecosystem">Ecosystem</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#license">License</a> ·
  <a href="https://stacx-lab.github.io/kinex/docs/">Documentation</a>
</p>

## What's New

- **2026.11.23**: Kinex v1.1.1 is released. The simulator project rosbridge is now
  [kinex-sim](https://github.com/stacx-lab/kinex-sim).
- **2026.11.04**: Kinex v1.1.0 is released! Devices now run as ROS 2 nodes, with ROS 2 Jazzy or Humble. See the [release notes](https://github.com/stacx-lab/kinex/releases/tag/v1.1.0).
- **2026.10.15**: Kinex v1.0.0 is released! Visit the [project website](https://stacx-lab.github.io/kinex/).

## How it works

Kinex connects a coding agent to robots through three layers:

- **Devices:** typed ROS interfaces to arms, grippers, cameras and models.
- **Graph:** Python programs the agent runs for perception and control.
- **Skills:** procedures that guide tasks such as device setup and calibration.

<p align="center">
  <img src="assets/architecture-day.svg#gh-light-mode-only" alt="Kinex architecture: the agent loads skills, runs graph programs through exec and calls devices directly; graph programs also operate devices, whose nodes exchange commands and feedback with hardware, simulators and model services." width="100%">
  <img src="assets/architecture-night.svg#gh-dark-mode-only" alt="Kinex architecture: the agent loads skills, runs graph programs through exec and calls devices directly; graph programs also operate devices, whose nodes exchange commands and feedback with hardware, simulators and model services." width="100%">
</p>

The agent loads skills as needed, then calls devices directly or runs Python
programs through `exec`, and reads back their results and images. Kinex works
with [simulators](#simulators) and [real robots](#real-world-robots), on its own
or [inside Pi, Claude Code and Codex](#other-harnesses). See the
[architecture guide](https://stacx-lab.github.io/kinex/docs/architecture/) and the
[documentation](https://stacx-lab.github.io/kinex/docs/).

## Quick start

**1. Install** on Linux or macOS. Kinex needs Node.js ≥22.19; the installer offers
to install it.

```sh
curl -fsSL https://raw.githubusercontent.com/stacx-lab/kinex/main/install.sh | bash
```

**2. Start Kinex** in your project.

```sh
cd /path/to/project
kinex
```

**3. Connect a model** with `/login`, then choose one with `/model`.

Running Python programs also needs [Pixi](https://pixi.sh) or uv: Kinex creates
the workspace's Python environment on first use, with ROS 2 Jazzy by default on
Linux x86-64. See [environment setup](docs/communication.md#kinex-python).

From the shell:

```sh
kinex "Inspect the workspace"          # Start with a prompt
kinex run "Describe the scene"         # Run a task and exit
kinex --continue                       # Resume the latest project session
kinex update                           # Update Kinex
kinex --help                           # All commands and options
```

See the [command reference](https://stacx-lab.github.io/kinex/docs/slash-commands/)
for in-session commands.

## Environments

### Simulators

[kinex-sim](https://github.com/stacx-lab/kinex-sim) runs public simulators and
exports a Kinex workspace for each task.

| Simulator | Robot | Tasks | Example task |
| --- | --- | --- | --- |
| [ABC](https://github.com/stacx-lab/kinex-sim/blob/main/docs/abc.md) | Two YAM arms | 33 | `abc/ball-tray-balancing` |
| [LIBERO](https://github.com/stacx-lab/kinex-sim/blob/main/docs/libero.md) | Franka Panda | 130 | `libero/libero-spatial-01` |
| [RoboTwin 2.0](https://github.com/stacx-lab/kinex-sim/blob/main/docs/robotwin.md) | ALOHA AgileX, two arms | 50 | `robotwin/beat-block-hammer-aloha-agilex` |
| [RoboDojo](https://github.com/stacx-lab/kinex-sim/blob/main/docs/robodojo.md) | Two ARX X5 arms | 42 | `robodojo/align-blocks` |
| [RoboCasa](https://github.com/stacx-lab/kinex-sim/blob/main/docs/robocasa.md) | Panda on an Omron mobile base | 365 | `robocasa/add-ice-cubes` |
| [BEHAVIOR](https://github.com/stacx-lab/kinex-sim/blob/main/docs/behavior.md) | R1Pro mobile manipulator | 100 | `behavior/assembling-gift-baskets` |
| [HandsOn](https://github.com/stacx-lab/kinex-sim/blob/main/docs/handson.md) | Two ROKAE AR5 arms with Wuji hands | 66 | `handson/t24-place-ball-in-bowl` |
| [BiDex-100](https://github.com/stacx-lab/kinex-sim/blob/main/docs/bidex.md) | Two Franka FR3v2 arms or an Astribot S1, with Sharpa Wave hands | 106, each also out of domain | `bidex/make-espresso` |

Pick a task, export its workspace and launch it on the same ROS domain:

```sh
kinex-sim tasks list --simulator libero
kinex-sim setup libero/libero-spatial-01 --directory ../workspace_libero --domain-id 83
kinex-sim launch libero/libero-spatial-01 --execution-mode stepped --domain-id 83
```

Then open Kinex in the exported directory and give it the task.
See [using kinex-sim with Kinex](https://github.com/stacx-lab/kinex-sim/blob/main/docs/kinex.md).

### Real-world robots

Open Kinex in your robot workspace and describe your hardware, how it connects
and the task:

```text
/onboarding Set up my robot arm, gripper, and overhead camera to pick objects from the table.
```

Onboarding connects the devices and prepares what the task needs. Then give
Kinex the task in plain language.

| Command | Use |
| --- | --- |
| `/devices` | Inspect the workspace |
| `/load <device>` | Connect a device |
| `/ping all` | Check connections |
| `/calibrate <scope>` | Calibrate further, for example `/calibrate camera-to-arm transform for picking` |
| `/stop` | Cancel the response and stop the actuators |
| `/unload <device>` | Release a device |

See [onboarding and calibration](https://stacx-lab.github.io/kinex/docs/onboarding/).

> [!CAUTION]
> You are responsible for safe operation. Always supervise real robots, keep a
> physical emergency stop within reach, and verify motion limits before running
> tasks. `/stop` does not replace a hardware emergency stop.

## Ecosystem

### Pi packages

Kinex is built on [Pi](https://pi.dev) and runs [Pi packages](https://pi.dev/packages):
extensions, skills, prompt templates and themes.
[pi-web-search](https://www.npmjs.com/package/pi-web-search) and
[pi-btw](https://www.npmjs.com/package/pi-btw) are bundled.

```sh
kinex install npm:pi-web-search         # From npm, Git or a local folder; -l for this project only
kinex list                             # Show installed and bundled packages
kinex update --extensions              # Update packages
kinex remove npm:pi-web-search          # Remove a package
```

Restart Kinex after changing packages.

### Other harnesses

Kinex also runs inside **Pi, Claude Code and Codex** through the plugins in
[kinex-plugins](https://github.com/stacx-lab/kinex-plugins). Install the plugin
for your harness, open your robot workspace and ask it to “Start Kinex.”

## Contributing

Issues and pull requests are welcome. Read [AGENTS.md](AGENTS.md) for contribution
rules. To develop from source, with Node ≥22.19, Python 3 and a POSIX host:

```sh
git clone https://github.com/stacx-lab/kinex.git
cd kinex
npm ci
npm run build
npm run dev
```

Before submitting code changes, run the full check:

```sh
python3 -m pip install -r packages/core/test/requirements.txt -r packages/setup/test/requirements.txt
npm run check
```

## Acknowledgements

Kinex builds on [Pi](https://github.com/earendil-works/pi), whose SDKs provide the
model integrations, coding tools, agent loop and terminal UI. Thanks to the Pi
maintainers and community.

## License

Kinex is licensed under the [Apache License, Version 2.0](LICENSE) and provided
"AS IS", without warranties. Third-party components retain their own licenses;
see the [third-party notices](THIRD_PARTY_NOTICES.txt).
