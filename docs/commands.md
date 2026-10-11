# In-session commands

Start `kinex` in your robot workspace. For shell options, run `kinex --help` or
see [Getting Started](../README.md#getting-started).

| Command | Purpose |
| --- | --- |
| `/login`, `/model` | Connect a provider and select a model. |
| `/onboarding [description]` | Prepare the robot and task prerequisites. |
| `/register <type-or-template>` | Create an unloaded device profile. |
| `/devices`, `/ping <device\|all>` | List devices or inspect live services. |
| `/load <device\|all>`, `/unload <device\|all>` | Connect or release devices. |
| `/stop [device]` | Cancel the response and stop actuators within their stop scope. |
| `/record start arm=10 camera=2`, `/record stop` | Start or finish recording. |
| `/calibrate [scope]` | Resolve selected calibration prerequisites. |
| `/mode [ask\|auto\|yolo]` | Choose tool approval and interaction behavior. |

Pi provides commands such as `/settings`, `/new`, `/resume`, and `/compact`.
`/reload` refreshes agent resources. To restart device connections after changing
profiles or restarting a simulator, use `/unload <device>` followed by
`/load <device>`, or restart Kinex. Use `all` to reconnect the whole collection.

See [devices and recording](devices.md) and [setup and calibration](setup.md)
for the underlying contracts.
