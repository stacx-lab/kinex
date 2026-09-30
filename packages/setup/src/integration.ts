import type { KinexContribution } from "@kinex/core/integration"
import type { CommandContext } from "@kinex/core"
import type { KinexSetup } from "./runtime.ts"
import { workflows } from "./workflows/index.ts"

export function setupContribution(setup: KinexSetup): KinexContribution {
  return {
    id: "setup",
    tools: {
      list: setup.tools.list,
      call: (name, input, call) => setup.tools.call(name, input, {
        sessionID: call.sessionID, callID: call.callID, signal: call.abort, ask: call.ask, questions: call.questions,
      }),
    },
    context: setup.context,
    commands: [
      ...([
        { name: "onboarding", description: "Set up a robotics workspace", arguments: "[description]" },
        { name: "register", description: "Prepare an unloaded device profile", arguments: "<type-or-template>" },
        { name: "calibrate", description: "Resolve calibration requirements", arguments: "[scope]" },
      ] as const).map(command => ({
        ...command, kind: "workflow" as const,
        async execute(args: string, context: CommandContext) {
          context.signal?.throwIfAborted()
          if (command.name === "register" && !args.trim()) throw new Error("Usage: /register <type-or-template>")
          return { kind: "workflow" as const, prompt: workflows[command.name].replaceAll("$ARGUMENTS", () => args.trim()) }
        },
      })),
      {
        name: "unregister", description: "Unload and delete a device", arguments: "<device>", kind: "operation",
        choices: async () => (await setup.devices.list()).map(device => device.name),
        async execute(args, context) {
          context.signal?.throwIfAborted()
          const tokens = args.trim().split(/\s+/).filter(Boolean)
          const name = tokens[0]
          if (!name || name === "all" || tokens.length !== 1) throw new Error("Usage: /unregister <device>")
          if (!await context.confirm(`Unregister ${name}?`, "Unload and delete its profile, driver and local files?")) return { kind: "output", text: "Cancelled" }
          await setup.devices.unregister(name, context.signal)
          return { kind: "output", text: `${name} unregistered` }
        },
      },
    ],
  }
}
