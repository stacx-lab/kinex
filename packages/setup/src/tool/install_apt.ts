import { z } from "zod"
import { define } from "@kinex/core/tool/tool"
import type { SetupHost } from "../host.ts"
import { installApt, needsAuthentication } from "../provisioning/apt.ts"
import DESCRIPTION from "./install_apt.txt"

export function installAptTool(host: SetupHost = {}) {
  return define("kinex_install_apt", {
    description: DESCRIPTION,
    parameters: z.strictObject({ packages: z.array(z.string().min(1)).min(1) }),
    async execute(args, ctx) {
      await ctx.ask({ permission: "shell", description: `Install system packages on this host: ${args.packages.join(", ")}` })
      ctx.abort.throwIfAborted()
      if (process.platform !== "linux") return { title: "Unsupported host", isError: true,
        output: "Apt installation requires the target Debian/Ubuntu Linux host. This tool only operates on the host running Kinex." }
      const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(75 * 60 * 1000)])
      const result = await installApt(args.packages, ctx.directory, signal)
      if (!needsAuthentication(result.metadata?.result) || !host.withTerminal) return result
      const terminal = await host.withTerminal({ signal,
        message: "Installing system packages. If requested, enter your password at sudo's prompt.",
      }, terminalSignal => installApt(args.packages, ctx.directory, AbortSignal.any([signal, terminalSignal]), true))
      return terminal.status === "completed" ? terminal.value : result
    },
  })
}
