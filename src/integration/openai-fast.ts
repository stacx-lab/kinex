import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export function registerOpenAIFast(pi: ExtensionAPI, report: (text: string) => void): void {
  // Leave provider/project defaults untouched until the user selects a tier.
  let enabled: boolean | undefined
  pi.on("before_provider_request", (event, ctx) => {
    if (enabled === undefined || ctx.model?.provider !== "openai") return
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return
    return { ...event.payload, service_tier: enabled ? "priority" : "default" }
  })
  pi.registerCommand("openai-fast", {
    description: "Request OpenAI Fast mode: on, off, status (premium API pricing)",
    getArgumentCompletions: prefix => {
      const matches = ["on", "off", "status"].filter(action => action.startsWith(prefix.trimStart().toLowerCase()))
      return matches.length ? matches.map(action => ({ value: action, label: action })) : null
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status"
      if (action === "on") enabled = true
      else if (action === "off") enabled = false
      else if (action !== "status") {
        const usage = "Usage: /openai-fast [on|off|status]"
        if (ctx.hasUI) ctx.ui.notify(usage, "warning")
        else report(usage)
        return
      }
      const state = enabled === undefined ? "provider/project default" : enabled ? "on (priority; premium API pricing)" : "off (standard)"
      const scope = ctx.model?.provider === "openai" ? "Applies to subsequent OpenAI requests." : "Inactive for this provider; applies only to openai."
      const message = `OpenAI Fast mode request: ${state}. ${scope} Resets when the session or extensions reload. The server determines the actual tier.`
      if (ctx.hasUI) ctx.ui.notify(message, "info")
      else report(message)
    },
  })
}
