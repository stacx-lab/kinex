import { parseArgs } from "node:util"
import { readFile } from "node:fs/promises"
import { InteractiveMode, runPrintMode } from "@earendil-works/pi-coding-agent"
import { createApplication } from "./application.ts"
import { executeRoboticsCommand } from "@kinex/core"
import { exportSession } from "./export.ts"
import { cancelTerminalOperation } from "./integration/terminal.ts"
import { runPackageCommand } from "./packages.ts"

const help = `Kinex — robotics coding agent

kinex [options]                       Interactive terminal
kinex run [options] "prompt"          Run once; prints the final reply
kinex run "/devices"                  Direct robotics command; no model needed
kinex --export session.jsonl [output.html]  Export a session without a model
kinex install <source> [-l, --local]   Install a Pi package (npm, Git, directory)
kinex remove <source> [-l, --local]    Remove a package; uninstall is an alias
kinex list                           List configured and bundled packages
kinex update [source]                Update packages; preserve version/ref pins
kinex upgrade [--all]                Upgrade Kinex; --all also updates packages

--model provider/model               Select a Pi model/provider
--thinking off|minimal|low|medium|high|xhigh
--continue                           Continue the latest workspace session
--session <id|file>                   Open a Kinex SDK session
--auto                               Approve tool permissions; keep interviews
--yolo                               Approve permissions; disable interviews
--enable-recording                   Expose recording controls to the model
--record "arm=10 camera=2"            Record during a headless run
--seed "prompt"                      Submit after interactive startup
--json                               Headless SDK events as JSON lines

TUI: /load /unload /ping /stop /devices /record
     /onboarding /register /calibrate /mode /model /login /new /compact
Pi's /reload refreshes agent resources. Python/uv remain external dependencies.
`

async function main(): Promise<void> {
  if (await runPackageCommand(process.argv.slice(2))) return
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    model: { type: "string" }, thinking: { type: "string" }, effort: { type: "string" },
    export: { type: "string" },
    continue: { type: "boolean" }, session: { type: "string" }, auto: { type: "boolean" }, yolo: { type: "boolean" },
    "enable-recording": { type: "boolean" }, record: { type: "string" }, seed: { type: "string" }, json: { type: "boolean" },
  } })
  if (values.help) { console.log(help); return }
  if (values.version) {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
    console.log(manifest.version)
    return
  }
  if (values.export !== undefined) {
    if (!values.export || positionals.length > 1 || positionals[0] === "") throw new Error("Usage: kinex --export <session.jsonl> [output.html]")
    process.exitCode = await exportSession(values.export, positionals[0])
    return
  }
  if (values.auto && values.yolo) throw new Error("Choose --auto or --yolo")
  const thinking = values.thinking ?? values.effort
  if (thinking !== undefined && thinking !== "off" && thinking !== "minimal" && thinking !== "low" && thinking !== "medium" && thinking !== "high" && thinking !== "xhigh") throw new Error("Invalid thinking level")
  const headless = positionals[0] === "run"
  if (!headless && positionals.length) throw new Error("Use kinex run <prompt> or --seed <prompt>")
  const prompt = positionals.slice(1).join(" ")
  if (headless && !prompt) throw new Error("Usage: kinex run <prompt>")
  if (!headless && (values.json || values.record)) throw new Error("--json and --record require kinex run")
  const app = await createApplication({
    cwd: process.cwd(), model: values.model, thinkingLevel: thinking,
    mode: values.yolo ? "yolo" : values.auto ? "auto" : "ask",
    enableRecording: values["enable-recording"], continue: values.continue, session: values.session,
    report: text => { if (!values.json) console.log(text) },
  })
  let interactive: InteractiveMode | undefined
  const shutdown = () => {
    if (cancelTerminalOperation()) return
    process.off("SIGINT", shutdown)
    void app.dispose().then(() => { interactive?.stop(); process.exit(130) }, error => {
      interactive?.stop(); console.error(String(error)); process.exit(1)
    })
  }
  process.on("SIGINT", shutdown)
  try {
    if (headless) {
      if (values.record && app.owner.runtime) {
        await Promise.all((await app.owner.runtime.devices.warmLoaded()).map(activation => activation.ready))
        const started = await executeRoboticsCommand(app.owner.runtime, "record", `start ${values.record}`, {
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
        mode: values.json ? "json" : "text",
        initialMessage: prompt,
      })
      if (app.owner.failure) process.exitCode = 1
    } else {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive Kinex needs a terminal; use kinex run <prompt>")
      interactive = new InteractiveMode(app.host, { initialMessage: values.seed })
      await interactive.run()
    }
  } finally {
    process.off("SIGINT", shutdown)
    await app.dispose()
  }
}

try { await main() }
catch (error) { console.error(`Kinex: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
