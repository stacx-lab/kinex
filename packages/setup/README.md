# @kinex/setup

Host-independent onboarding and calibration for Kinex.
Requires Node >=22.19 and an aligned `@kinex/core` version. It contains no host
agent, provider, UI or independent device runtime.

Core alone provisions, registers, removes and operates devices. It owns device
guides, driver templates, setup-device, profile_write and runtime utilities:
lifecycle, reads/writes, stop, transforms, FK/IK, perception, motion/policy tools,
recording and runtime Python. Setup coordinates workspace onboarding and
calibration measurements using those core capabilities.

## Composition

```ts
import { createKinexRuntime } from "@kinex/core"
import { coreContribution, composeContributions } from "@kinex/core/integration"
import {
  createKinexSetup, setupContribution, setupSkillRoots, setupToolNames,
} from "@kinex/setup"

const runtime = createKinexRuntime({
  directory: process.cwd(),
  builtinSkillRoots: setupSkillRoots,
  reservedToolNames: setupToolNames,
  host: {
    ask: async request => { /* resolve only after authorization; throw on denial */ },
    questions: async questions => { /* use the host question UI */ return {} },
  },
})
const setup = createKinexSetup(runtime)
const capabilities = composeContributions([
  coreContribution(runtime), setupContribution(setup),
])
try {
  const tools = await capabilities.tools.list()
  const skills = await capabilities.skills.list()
  const context = await capabilities.context()
  // Register capabilities.commands and route model calls through capabilities.tools.
} finally {
  await runtime.dispose()
}
```

Standalone enables this composition by default. Other consumers opt in explicitly.
Skill discovery belongs to the runtime: supplying `setupSkillRoots` makes both the
core skill tool and composed catalog use the same project/ancestor/global/builtin
precedence. `setupToolNames` reserves feature names ahead of workspace custom tools.
No package loader or global registration is involved.

Hosts may pass `setupPermissionDefaults` as the third argument to core's
`kinexPermissionAction(permission, rules, featureDefaults)`. It supplies
`device_calibrate: ask`; core supplies `profile_write: allow`. Explicit configured
rules take precedence. Missing host callbacks still deny permission requests. The contribution
uses invocation permission/question callbacks and never bypasses the host.

## APIs and migration

| API or feature | Owner |
| --- | --- |
| `runtime.devices.templates()` / `runtime.devices.unregister(name, signal?)` | Core |
| `/register`, `/unregister`, setup-device and provisioning bundles | Core |
| `profile_write` tool, profiles and readiness | Core |
| `setup.calibration.plan()` | Setup; enriches core readiness with procedural guidance |
| `/onboarding`, `/calibrate` | Setup contribution |
| `calib_plan`, `calib_sample`, `device_calibrate` | Setup tools or composed capabilities |
| `workflows` from `@kinex/setup` | Onboarding and calibrate prompts |
| `CalibrationResult` / `nowMeta`, calibration evidence and routines | Setup |

Replace `setup.devices.templates/unregister` with the corresponding runtime methods;
setup no longer exposes a device facade. Register's workflow is available from
`@kinex/core/workflows/index`. Replace `calib_write` calls with core's `profile_write`
and migrate `permission.calib_write` rules to `permission.profile_write`. There is
no compatibility alias. Setup tools do not forward profile-writing calls; use
`runtime.tools.call` or the composed catalog.

`ProfileStore` replaces the former low-level `CalibrationStore` name. Core owns
schemas, trusted profile writes, readiness and URDF model resolution. Workspace
schemas and calibration record formats are unchanged.

Setup construction is inert and borrows the core runtime. Commands are trusted
user operations; tools use core's tracked execution bridge. The host owns runtime
initialization and disposal; setup never creates a second device runtime.

## Assets

Setup ships calibration skills and scripts. Device guides, provisioning bundles,
starter drivers and setup-device belong to core. Read core's Device guide roots
for Setup/Profile and Use sections, including workspace/global overrides.
Discovery never creates a nearer workspace or prepares Python. Calibration scripts
use core's lazy environment or an explicitly configured vendor interpreter.

Drivers and their runtime support modules are copied into device workspaces during
provisioning. Configured devices and registration remain usable without setup.

## Checks

From the repository root, run `npm run test:setup` for calibration, permissions,
cleanup, discovery and installed-package tests. The package test provisions a device,
removes setup, then operates it using only core. Run builds and consumer tests
sequentially. `npm run pack -- OUTPUT_DIRECTORY` packs core, setup and standalone;
it does not publish them. Native plugin snapshot adoption remains separate work.
