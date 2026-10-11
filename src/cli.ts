import { readFile } from "node:fs/promises"
import { InteractiveMode, runPrintMode } from "@earendil-works/pi-coding-agent"
import { createApplication } from "./application.ts"
import { executeRoboticsCommand } from "@kinex/core"
import { exportSession } from "./export.ts"
import { runPackageCommand } from "./packages.ts"
import { isPrintMode, parseKinexArgs } from "./arguments.ts"
import { selectSession } from "./sessions.ts"
import { installResumeHint } from "./resume-hint.ts"

const help = `Kinex — robotics coding agent

kinex [options] ["prompt" ...]         Interactive terminal with optional prompts
kinex -p "prompt"                     Run once; prints the final reply
kinex run "prompt"                    Alias for kinex -p
kinex -p "/devices"                   Direct robotics command; no model needed
kinex --export session.jsonl [output.html]  Export a session without a model
kinex install <source> [-l, --local]   Install a Pi package (npm, Git, directory)
kinex remove <source> [-l, --local]    Remove a package; uninstall is an alias
kinex list                           List configured and bundled packages
kinex update [--self]                 Update Kinex and its bundled Pi SDK
kinex update --extensions             Update packages; preserve version/ref pins
kinex update <source>                 Update one installed package
kinex update --all                    Update Kinex and installed packages

--model <pattern>                    Pi model matching; accepts provider/model
--provider <name>                    Limit --model to a provider
--thinking off|minimal|low|medium|high|xhigh|max
--print, -p                          Process prompts and exit (also for pipes)
--mode text|json                     Final text or JSON event output
--continue, -c                       Continue the latest workspace session
--resume, -r                         Choose a previous Kinex session
--session <id|file>                   Open a Kinex SDK session
--auto                               Approve tool permissions; keep interviews
--yolo                               Approve permissions; disable interviews
--enable-recording                   Expose recording controls to the model
--record "arm=10 camera=2"            Record during a headless run
--help, -h                           Show help
--version, -v                        Show Kinex version

Piped text is prepended to the first prompt. Use -- before prompts starting with -.
RPC, @file attachments and advanced Pi tool/resource flags are not supported.

TUI: /load /unload /ping /stop /devices /record
     /onboarding /register /calibrate /mode /model /login /new /compact
Pi's /reload refreshes agent resources. Python/uv remain external dependencies.
`

async function main(): Promise<void> {
  if (await runPackageCommand(process.argv.slice(2))) return
  const { pi: values, mode, enableRecording, record } = parseKinexArgs(process.argv.slice(2))
  for (const diagnostic of values.diagnostics) console.error(`Kinex: ${diagnostic.message}`)
  if (values.help) { console.log(help); return }
  if (values.version) {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    console.log(manifest.version)
    return
  }
  if (values.export !== undefined) {
    if (!values.export || values.messages.length > 1 || values.messages[0] === "") throw new Error("Usage: kinex --export <session.jsonl> [output.html]")
    process.exitCode = await exportSession(values.export, values.messages[0])
    return
  }
  const headless = isPrintMode(values, !!process.stdin.isTTY, !!process.stdout.isTTY)
  if (!headless && record) throw new Error("--record requires non-interactive mode; use --print")
  let session = values.session
  if (!session && values.resume) {
    session = await selectSession(process.cwd())
    if (!session) { console.log("No session selected"); return }
  }
  let stdin = ""
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf8")
    for await (const chunk of process.stdin) stdin += chunk
  }
  const messages = [...values.messages]
  const initialMessage = [stdin.trim(), messages.shift()].filter(value => value !== undefined && value !== "").join("") || undefined
  const app = await createApplication({
    cwd: process.cwd(), model: values.model, provider: values.provider, thinkingLevel: values.thinking,
    mode, enableRecording, continue: values.continue, session,
    report: text => { if (values.mode !== "json") console.log(text) },
  })
  let interactive: InteractiveMode | undefined
  const shutdown = () => {
    void app.dispose().then(() => { interactive?.stop(); process.exit(130) }, error => {
      interactive?.stop(); console.error(String(error)); process.exit(1)
    })
  }
  process.once("SIGINT", shutdown)
  let restoreHint: (() => void) | undefined
  try {
    if (headless) {
      if (record && app.owner.runtime) {
        await Promise.all((await app.owner.runtime.devices.warmLoaded()).map(activation => activation.ready))
        const started = await executeRoboticsCommand(app.owner.runtime, "record", `start ${record}`, {
          sessionID: app.host.session.sessionId, confirm: async () => false,
        })
        if (started.kind !== "output") throw new Error("Recording did not return a result")
        const report: unknown = JSON.parse(started.text)
        if (report && typeof report === "object" && "refusals" in report && report.refusals && typeof report.refusals === "object") {
          const refusals = Object.entries(report.refusals)
          if (refusals.length) console.error(`Kinex: --record refused: ${refusals.map(([device, reason]) => `${device}: ${reason}`).join("; ")}`)
        }
      }
      process.exitCode = await runPrintMode(app.host, {
        mode: values.mode === "json" ? "json" : "text", initialMessage, messages,
      })
      if (app.owner.failure) process.exitCode = 1
    } else {
      restoreHint = installResumeHint(() => app.host.session.sessionManager)
      interactive = new InteractiveMode(app.host, { initialMessage, initialMessages: messages })
      await interactive.run()
    }
  } finally {
    restoreHint?.()
    process.off("SIGINT", shutdown)
    await app.dispose()
  }
}

try { await main() }
catch (error) { console.error(`Kinex: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
