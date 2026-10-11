# Kinex

Read [docs/README.md](docs/README.md) for design contracts and [README.md](README.md)
for usage.
Design history and progress belong in git.

## Ownership

- `packages/core/src` owns device management and operation; core assets own runtime
  Python, tools, non-ROS provisioning bundles, device guides and setup-device. Core must not
  import setup, a host agent or UI.
- `packages/setup` owns onboarding and calibration procedures/assets, including
  ROS skills, provisioning, adapters and dependency checks. Core has no ROS implementation
  or dependency. Setup borrows core runtime resources through package exports.
- `src` composes standalone with published Pi SDKs; `src/integration` owns its
  product policy. Do not fork/reimplement providers, coding tools, loops or TUI.
- Native Pi, OpenCode and Codex plugins live in the separate `../kinex-plugins`
  project. Standalone owns its Pi integration in `src/integration`; do not import
  plugin packages or constrain standalone SDK upgrades to plugin compatibility.
- Core is the shared package boundary. Plugins consume explicit packed snapshots;
  changing core here does not update their snapshot automatically.

## Invariants

- Preserve workspace discovery precedence and lazy `.kinex/python`; do not
  activate core Python in ordinary shells or create it during discovery.
- Separate trusted commands from permission-checked model tools. Python tools
  cannot change device lifecycle; model recording remains opt-in.
- Preserve initialization ordering, cancellation, recording ownership and disposal.
  Use the owned process helper for core subprocesses; never terminate borrowed
  services. Retain the [control](docs/control.md) and
  [calibration](docs/setup.md) contracts.
- Keep dynamic state out of stable prompt prefixes. Refresh capabilities within
  tasks and restore context after compaction without bypassing host permissions.

## Style and checks

TypeScript ESM, Node APIs, npm and Zod v4. Prefer small functions, named imports,
early returns and async/await. Avoid `any`, unnecessary casts/catches and obsolete
compatibility layers; retain typed errors (`NamedError`). Imported prose belongs
in sibling `.txt` files; discovered content belongs in its owning package assets.

- Full integration: `npm run check` builds/typechecks once, then runs core, setup,
  standalone, PTY and packed-consumer checks. Focused edits may use `npm test`,
  `npm run test:core` or `npm run test:setup`; package independence is checked by
  `npm test`/`npm run check`.
- Build/package: `npm run build`, then `npm run pack -- OUTPUT_DIRECTORY`.

Builds replace output: never rebuild packages concurrently with consumer tests.
Use Node >=22.19 and Python 3 for POSIX PTY tests. Release work follows README.md;
routine builds/tests do not publish packages.
Documentation-only changes need link/diff checks, not a full test run.
