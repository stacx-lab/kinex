# @kinex/setup

Host-independent onboarding, device provisioning and calibration for Kinex.
Requires Node >=22.19 and an aligned `@kinex/core` version. It contains no host
agent, provider, UI or independent device runtime.

Core alone provides all utilities needed to operate a configured inventory:
lifecycle, reads/writes, stop, transforms, FK/IK, perception, motion/policy tools,
recording and runtime Python. Setup prepares or changes that inventory.

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
`kinexPermissionAction(permission, rules, featureDefaults)`. It preserves
`calib_write: allow` and `device_calibrate: ask`; explicit configured rules take
precedence. Missing host callbacks still deny permission requests. The contribution
uses invocation permission/question callbacks and never bypasses the host.

## APIs and migration

| Previous core API | Replacement |
| --- | --- |
| `runtime.calibration.plan()` | `setup.calibration.plan()`; `runtime.readiness()` for operational completeness |
| `runtime.devices.templates()` | `setup.devices.templates()` |
| `runtime.devices.unregister(name)` | `setup.devices.unregister(name, signal?)` |
| Core onboarding/register/calibrate/unregister commands | `setupContribution(setup).commands` |
| Core `calib_plan`, `calib_write`, `calib_sample`, `device_calibrate` tools | `setup.tools` or composed capabilities |
| `@kinex/core/workflows/index` | `workflows` from `@kinex/setup` |
| `CalibrationResult` / `nowMeta` in core profile schema | `@kinex/setup/calibration/schema` |
| Core calibration store/model subpaths | Core `device/profile/store`, `device/profile/readiness`, `device/joint-model`, `device/device-model` |

`ProfileStore` replaces the low-level `CalibrationStore` name. Core retains trusted
profile writes, schemas, shared completeness checks and URDF model resolution.
No compatibility re-exports are provided. Workspace schemas and calibration record
formats are unchanged. Consumers pointing drivers directly into the old packaged
provisioning bundles must copy those files into their device workspace and update
the driver entry; provisioned workspace-local drivers need no migration.

Setup construction is inert and borrows the core runtime. Commands are trusted
user operations; tools use core's tracked execution bridge. Unregister confirms
through the host command context, holds the per-device lifecycle fence through
capture shutdown/deactivation/deletion, and preserves files if deactivation fails.
The trusted `setup.devices.unregister()` method itself does not prompt.

## Assets

Setup ships calibration skills/scripts and device provisioning bundles. Bundled
Setup/Profile guides live here; runtime Use conventions remain in core. Existing
combined workspace/global DEVICE.md overrides still work. Discovery never creates
a nearer workspace or prepares Python; execution uses core's lazy environment.

Copy drivers and all runtime support modules into the device workspace during
provisioning. Do not point registered drivers or runtime imports into this package:
a configured inventory must keep operating after setup is removed. Normal runtime
Python helpers belong to core. Explicit vendor environments own their dependencies.

## Checks

From the repository root, run `npm run test:setup` for calibration, permissions,
cleanup, discovery and installed-package tests. The package test provisions a device,
removes setup, then operates it using only core. Run builds and consumer tests
sequentially. `npm run pack -- OUTPUT_DIRECTORY` packs core, setup and standalone;
it does not publish them. Native plugin snapshot adoption remains separate work.
