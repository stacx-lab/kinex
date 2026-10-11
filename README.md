<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/kinex-logo-text-night.svg">
    <img src="assets/kinex-logo-text-day.svg" alt="Kinex" height="100">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/stacx-lab/kinex/releases">
    <img src="https://img.shields.io/github/v/release/stacx-lab/kinex?style=flat-square&amp;label=release&amp;color=2563eb" alt="Latest release" height="20">
  </a>
  <a href="https://github.com/stacx-lab/kinex/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/stacx-lab/kinex/ci.yml?branch=main&amp;style=flat-square&amp;label=CI" alt="CI status on main" height="20">
  </a>
  <a href="#getting-started">
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-339933?style=flat-square&amp;logo=node.js&amp;logoColor=white" alt="Node.js ≥22.19" height="20">
  </a>
  <a href="#getting-started">
    <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-555555?style=flat-square" alt="Platforms: Linux and macOS" height="20">
  </a>
</p>

<p align="center">
  <a href="#news">News</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#use-kinex-with-real-world-robots">Real-World Robots</a> ·
  <a href="#use-kinex-with-simulators">Simulators</a> ·
  <a href="#kinex-and-the-pi-ecosystem">Pi Ecosystem</a> ·
  <a href="#using-kinex-with-other-harnesses">Other Harnesses</a>
</p>

Kinex is a robotics harness for coding agents, built on the published Pi SDK.

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
Python tools and drivers also need Python 3 and uv; video encoding requires ffmpeg.

You can also run a single task, resume a session, or update from the shell:

```sh
kinex run "Inspect the workspace"       # Run a single task
kinex run "/ping arm"                   # Device command without a model
kinex --continue                       # Resume the latest project session
kinex --model provider/model           # Start with a selected model
kinex upgrade                          # Update Kinex and its bundled Pi SDK
kinex --help                           # All commands and options
```

See the [command reference](docs/commands.md) for in-session commands.

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
to release a device. See [setup and calibration](packages/setup/README.md#tools-and-workflows)
for more detail.

## Use Kinex with Simulators

[RoboEnv](https://github.com/stacx-lab/RoboEnv) runs simulator tasks and exposes
their robots as Kinex devices. Install it using the
[setup guide](https://github.com/stacx-lab/RoboEnv/blob/main/docs/setup.md), which
covers Linux, GPU requirements, and simulator assets. With the RoboEnv CLI
activated, prepare and launch a RoboCasa task in terminal A:

```sh
roboenv prepare robocasa
roboenv tasks list --simulator robocasa
roboenv launch robocasa/pick-place-microwave --port 8123
```

Wait for `Ready` and leave it running. In terminal B, activate the same RoboEnv
CLI and set up an agent workspace:

```sh
source /path/to/RoboEnv/.venv/bin/activate
mkdir -p kinex-sim-workspace
cd kinex-sim-workspace
roboenv setup --list
roboenv setup robocasa/robocasa-panda-omron
export ROBOENV_ENDPOINT=http://127.0.0.1:8123
roboenv describe
kinex
```

Replace `/path/to/RoboEnv` with your checkout location. `roboenv setup` creates
`.kinex/` if needed and exports the robot's `workspace.yaml` and devices.
Existing configuration is protected; `--force` replaces the manifest and entire
device collection while preserving other workspace content.

In Kinex, check `/devices` and `/ping all`, then give the agent the instruction
from `roboenv describe`. RoboEnv owns the task verdict: inspect it with
`roboenv score` in a terminal using the same endpoint. For other tasks, select a
task ID and its matching robot from the lists above. Ctrl-C in terminal A stops
the simulation. See the
[RoboEnv walkthrough](https://github.com/stacx-lab/RoboEnv/blob/main/docs/kinex-local.md)
for connection details, recording, and playback.

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
kinex update                           # Update packages, preserving version pins
kinex remove npm:pi-web-search          # Restore the bundled fallback
```

Installs default to user scope; `-l` selects the project. Restart after changing
packages. Browse [Pi packages](https://pi.dev/packages) or read the
[package documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/packages.md).

## Using Kinex with Other Harnesses

We also provide plugins for Pi, OpenCode and Codex that package Kinex's core
utilities—including device tools, skills and robot context—for use within those
harnesses. They are maintained in the separate
[kinex-plugins repository](https://github.com/stacx-lab/kinex-plugins).

Choose your harness there, follow its installation and configuration instructions,
then open your robot workspace in that harness. Plugins use the shared Kinex core
while retaining the host's coding workflow; standalone Kinex is not required.
Plugin releases and their bundled core versions are updated independently.

## Contributing & Development

Issues and pull requests are welcome. Read [AGENTS.md](AGENTS.md) for contribution
rules and the [design documentation](docs/README.md) for package boundaries and
runtime contracts.
The [core](packages/core/README.md) and [setup](packages/setup/README.md) docs cover
APIs, control examples and onboarding.

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

For releases, edit only `VERSION`, run `npm run version:sync`, `npm run version:check`
and `npm run check`, then validate with
`node script/release.mjs --check --tag "v$(cat VERSION)"`. Commit synchronized
metadata before tagging. `npm run pack -- /tmp/kinex-release` packs the three
packages after a build. Matching `v*` tags publish tarballs and `SHA256SUMS` to
GitHub Releases; routine checks do not publish packages.

## Acknowledgements

Kinex builds on [Pi](https://github.com/earendil-works/pi). Its published SDKs
provide the model integrations, coding tools, agent loop, session management and
terminal UI. Thanks to the Pi maintainers and community for the foundation and
plugin ecosystem that make Kinex possible.
