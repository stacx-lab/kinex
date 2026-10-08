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
    commands: ([
      { name: "onboarding", description: "Set up a robotics workspace", arguments: "[description]" },
      { name: "onboarding-ros2", description: "Set up ROS 2 hardware", arguments: "[description]" },
      { name: "calibrate", description: "Resolve calibration requirements", arguments: "[scope]" },
    ] as const).map(command => ({
      ...command, kind: "workflow" as const,
      async execute(args: string, context: CommandContext) {
        context.signal?.throwIfAborted()
        return { kind: "workflow" as const, prompt: workflows[command.name].replaceAll("$ARGUMENTS", () => args.trim()) }
      },
    })),
  }
}
