import path from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { z } from "zod"
import { ConfigPaths } from "../config/paths.ts"
import { Assets } from "../installation/assets.ts"
import { pythonEnvironment } from "../python/environment.ts"
import { NamedError } from "../util/error.ts"
import { spawnProcess, which } from "../util/process.ts"
import { libNode, libRoots } from "./catalog.ts"

// The flow chart of a program or of a lib function: itself and every function it can
// reach, each a tree of steps. A call step names the function it opens, so a viewer
// shows one node per call and unfolds the callee's own chart on demand.
// kinex/host/flow.py derives it from source alone.
const at = { line: z.number().int(), end: z.number().int() }
// Steps nest, so the block's static type stops at unknown; parsing still checks every level.
const Block: z.ZodType<unknown[]> = z.lazy(() => z.array(FlowStep))
const Io = z.strictObject({
  kind: z.literal("io"), verb: z.enum(["request", "publish", "read", "subscribe", "next", "latest"]),
  operation: z.string().describe("the operation's name, or its expression when dynamic"), dynamic: z.boolean(), ...at,
})
const Call = z.strictObject({ kind: z.literal("call"), label: z.string(), target: z.string().nullable().describe("the called function's id; null when it is not charted"), ...at })
const Compute = z.strictObject({ kind: z.literal("compute"), names: z.array(z.string()).describe("the names these statements assign"), ...at })
const Subagent = z.strictObject({
  kind: z.literal("subagent"), instruction: z.string().describe("the instruction's first line, or its expression when dynamic"), dynamic: z.boolean(),
  shows: z.array(z.string()).describe("the names of the items shown to the subagent"), ...at,
})
const Wait = z.strictObject({ kind: z.literal("wait"), label: z.string(), ...at })
const Exit = z.strictObject({ kind: z.literal("exit"), how: z.enum(["return", "raise", "break", "continue", "finish"]), label: z.string(), ...at })
const Join = z.strictObject({ kind: z.literal("join"), task: z.string(), ...at })
const Cancel = z.strictObject({ kind: z.literal("cancel"), task: z.string(), ...at })
const Branch = z.strictObject({
  kind: z.literal("branch"), ...at,
  arms: z.array(z.strictObject({ condition: z.string(), body: Block })),
  orelse: Block,
})
const Loop = z.strictObject({ kind: z.literal("loop"), header: z.string(), ...at, body: Block, orelse: Block })
const Scope = z.strictObject({ kind: z.literal("scope"), label: z.string(), timeout: z.boolean(), ...at, body: Block })
const Try = z.strictObject({
  kind: z.literal("try"), ...at,
  body: Block,
  handlers: z.array(z.strictObject({ exception: z.string(), body: Block })),
  orelse: Block,
  final: Block,
})
const Parallel = z.strictObject({
  kind: z.literal("parallel"), mode: z.enum(["all", "first"]).describe("continues when all branches finish, or when the first does"), ...at,
  branches: z.array(z.strictObject({ each: z.string().nullable().describe("set when the branch runs once per item"), body: Block })),
})
const Spawn = z.strictObject({ kind: z.literal("spawn"), task: z.string().nullable(), ...at, body: Block })
export const FlowStep = z.discriminatedUnion("kind", [Io, Subagent, Call, Compute, Wait, Exit, Join, Cancel, Branch, Loop, Scope, Try, Parallel, Spawn])
export const FlowFunction = z.strictObject({
  id: z.string(),
  path: z.string().describe("module.function in kinex.lib, file:function outside it, or the file's name for a whole program"),
  name: z.string(),
  file: z.string(),
  ...at,
  signature: z.string().describe("empty for a whole program"),
  doc: z.string(),
  source: z.string(),
  body: Block,
})
export const Flow = z.strictObject({
  entry: z.string(),
  functions: z.record(z.string(), FlowFunction),
  problems: z.array(z.string()),
})
export type Flow = z.infer<typeof Flow>

/** The flow of a program file (file.py), of one of its functions (file.py:function) or of a lib function (module.function). */
export async function flowChart(cwd: string, target: string, signal?: AbortSignal): Promise<Flow> {
  const [, script, named] = /^(.*\.py)(?::([A-Za-z_]\w*))?$/.exec(target) ?? []
  const located = script === undefined ? (await libNode(cwd, target)).node : undefined
  if (located && located.kind !== "function")
    throw new Error(`${target || "the library"} is a module; chart one of its functions${located.functions.length ? `: ${located.functions.join(", ")}` : ""}`)
  const file = located?.file ?? path.resolve(cwd, script!)
  const name = located ? target.slice(target.lastIndexOf(".") + 1) : named ?? ""
  // Parsing needs only the standard library, so a missing Kinex Python is not prepared for it.
  const environment = await pythonEnvironment(cwd)
  const executable = environment.present ? environment.executable : await which("python3")
  if (!executable) throw new NamedError("FlowError", "Charting needs Python 3: prepare Kinex Python or install python3")
  const roots = (await libRoots(cwd)).map(root => root.directory)
  const proc = spawnProcess([executable, "-I", Assets.python("kinex", "host", "flow.py"), file, name, ...roots], { stdout: "pipe", stderr: "pipe", signal })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  signal?.throwIfAborted()
  if (code !== 0) throw new NamedError("FlowError", err.trim().split("\n").at(-1) || `flow.py exited with code ${code}`)
  return Flow.parse(JSON.parse(out))
}

/** A self-contained page that draws a flow chart. */
export async function flowPage(flow: Flow): Promise<string> {
  const page = await readFile(Assets.viewer("flow.html"), "utf8")
  // The data sits in a script element: escaping "<" and everything beyond printable ASCII
  // keeps it from closing that element or breaking the script's lines.
  const data = JSON.stringify(flow).replace(/[^\x20-\x3b\x3d-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
  return page.replace("/*FLOW*/null", () => data)
}

/** Write a flow chart page, by default to the workspace's flow/ directory. */
export async function writeFlowPage(cwd: string, target: string, output?: string, signal?: AbortSignal) {
  const flow = await flowChart(cwd, target, signal)
  const entry = flow.functions[flow.entry]!
  const file = output ? path.resolve(cwd, output) : path.join(await ConfigPaths.projectDir(cwd), "flow", `${entry.path.replace(/[^\w.-]+/g, "_")}.html`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, await flowPage(flow))
  return { file, flow }
}
