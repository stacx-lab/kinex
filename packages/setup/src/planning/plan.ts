import { currentSignal } from "@kinex/core/scope"
import { NamedError } from "@kinex/core/util/error"
import { z } from "zod"
import { Plan, StoredPlan, Outcome, Task, Fact, ID, Pointer, type PlanNode } from "./schema.ts"
import { atomicJSON, digest, fail, inspectFacts, location, optionalText } from "./facts.ts"
import { procedures, requirements } from "./procedures.ts"

const writes = new Map<string, Promise<unknown>>()
export async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(action)
  writes.set(key, pending)
  try { return await pending } finally { if (writes.get(key) === pending) writes.delete(key) }
}
export async function readPlan(cwd: string): Promise<StoredPlan | undefined> {
  const text = await optionalText(await location(cwd, "setup/plan.json"))
  return text === undefined ? undefined : StoredPlan.parse(JSON.parse(text))
}
export function ordered(plan: Plan): PlanNode[] {
  const nodes = new Map(plan.nodes.map(node => [node.id, node]))
  if (nodes.size !== plan.nodes.length) fail("Duplicate node IDs")
  const order: PlanNode[] = [], visited = new Set<string>(), visiting: string[] = []
  function visit(id: string) {
    if (visited.has(id)) return
    const node = nodes.get(id)
    if (!node) fail(`Unknown dependency ${id}`)
    if (visiting.includes(id)) fail(`Dependency cycle: ${[...visiting.slice(visiting.indexOf(id)), id].join(" -> ")}`)
    visiting.push(id)
    for (const dep of node.dependsOn) visit(dep)
    visiting.pop(); visited.add(id); order.push(node)
  }
  for (const node of plan.nodes) visit(node.id)
  for (const id of plan.task?.targets ?? []) if (!nodes.has(id)) fail(`Unknown task target ${id}`)
  return order
}
function closure(plan: Plan, targets: string[]) {
  const selected = new Set<string>()
  const add = (id: string) => {
    if (selected.has(id)) return
    const node = plan.nodes.find(node => node.id === id)
    if (!node) fail(`Unknown target ${id}`)
    selected.add(id); node.dependsOn.forEach(add)
  }
  targets.forEach(add)
  return selected
}
function covers(output: Fact, input: Fact) {
  if (output.kind !== input.kind) return false
  if (output.kind === "file" && input.kind === "file") return output.path === input.path
  return output.kind === "profile" && input.kind === "profile" && output.device === input.device &&
    (input.pointer === output.pointer || input.pointer.startsWith(output.pointer + "/"))
}
export async function validatePlan(cwd: string, plan: Plan) {
  ordered(plan)
  const catalog = await procedures(cwd)
  for (const node of plan.nodes) {
    const inputs = await requirements(cwd, node, catalog)
    const missing = (await inspectFacts(cwd, inputs)).missing
    const ancestors = closure(plan, node.dependsOn)
    for (const input of missing) {
      const producers = plan.nodes.filter(other => other.id !== node.id && other.outputs.some(output => covers(output, input)))
      if (producers.length && !producers.some(other => ancestors.has(other.id)))
        fail(`${node.id}: missing dependency on a producer of ${JSON.stringify(input)} (${producers.map(other => other.id).join(", ")})`)
    }
  }
}
export async function savePlan(cwd: string, input: Plan, revision: number) {
  const file = await location(cwd, "setup/plan.json")
  return serialized(file, async () => {
    const previous = await readPlan(cwd)
    if ((previous?.revision ?? 0) !== revision) fail("Plan changed; read it again before saving")
    const plan = Plan.parse(input)
    await validatePlan(cwd, plan)
    const receipts = Object.fromEntries(Object.entries(previous?.receipts ?? {}).filter(([id]) => plan.nodes.some(node => node.id === id)))
    const saved = { ...plan, receipts, revision: revision + 1 }
    currentSignal()?.throwIfAborted()
    await atomicJSON(file, saved)
    return saved
  })
}
export async function selectTask(cwd: string, task: typeof Task._output | null, revision: number) {
  const file = await location(cwd, "setup/plan.json")
  return serialized(file, async () => {
    const plan = await readPlan(cwd)
    if (!plan || plan.revision !== revision) fail("Plan changed or is missing; read it again")
    const saved = { ...plan, task: task === null ? null : Task.parse(task), revision: revision + 1 }
    // Switching objectives must not demand repair of an unrelated procedure.
    ordered(saved)
    currentSignal()?.throwIfAborted()
    await atomicJSON(file, saved)
    return saved
  })
}
export type NodeStatus = "ready" | "blocked" | "needs-input" | "partial" | "done" | "failed" | "stale"
export const dependencies = (plan: StoredPlan, node: PlanNode) => digest(node.dependsOn.map(id => [id, plan.receipts[id]]))
async function inspectValidPlan(cwd: string) {
  const plan = await readPlan(cwd)
  const catalog = await procedures(cwd)
  if (!plan) return { revision: 0, task: null, taskSatisfied: null, nodes: [], next: [],
    procedures: catalog, message: "No setup plan. Existing operations remain available; use /onboarding to prepare only what the task needs." }
  const active = closure(plan, plan.task?.targets ?? [])
  const states = new Map<string, NodeStatus>()
  const views = new Map<string, { status: NodeStatus; reasons: string[] }>()
  for (const node of ordered(plan)) {
    const deps = node.dependsOn.filter(id => states.get(id) !== "done")
    let facts: Fact[]
    try { facts = await requirements(cwd, node, catalog) } catch (error) {
      if (!(error instanceof NamedError)) throw error
      states.set(node.id, "needs-input")
      views.set(node.id, { status: "needs-input", reasons: [error.message] })
      continue
    }
    const inputs = await inspectFacts(cwd, facts)
    const outputs = await inspectFacts(cwd, node.outputs)
    const receipt = plan.receipts[node.id]
    const evidence = receipt ? await inspectFacts(cwd, receipt.evidence.map(path => ({ kind: "file", path }))) : undefined
    const changed = receipt && (receipt.definition !== digest(node) || receipt.inputs !== inputs.hash ||
      receipt.outputs !== outputs.hash || receipt.evidenceHash !== evidence?.hash || receipt.dependencies !== dependencies(plan, node))
    const stale = receipt?.status === "done" && (changed || deps.length > 0)
    const status: NodeStatus = stale ? "stale" : deps.length ? "blocked" : inputs.missing.length ? "needs-input" :
      receipt && !changed ? receipt.status : "ready"
    states.set(node.id, status)
    views.set(node.id, { status, reasons: [
      ...deps.map(id => `requires ${id}`), ...inputs.missing.map(fact => `missing ${JSON.stringify(fact)}`),
      ...(stale ? ["Evidence or a dependency changed; reassess the affected facts"] : []),
      ...(receipt?.note ? [receipt.note] : []),
    ] })
  }
  const nodes = plan.nodes.map(node => ({ ...node, ...views.get(node.id)!,
    relevance: active.has(node.id) ? "required-now" : node.optional ? "optional" : "deferred" }))
  const missing = plan.task ? (await inspectFacts(cwd, plan.task.facts)).missing : []
  return { revision: plan.revision, task: plan.task, taskSatisfied: plan.task ?
    [...active].every(id => states.get(id) === "done") && !missing.length : null,
  missing, nodes, next: nodes.filter(node => active.has(node.id) && ["ready", "partial", "failed", "stale"].includes(node.status) &&
    !node.reasons.some(reason => reason.startsWith("requires ") || reason.startsWith("missing "))).map(node => node.id), procedures: catalog }
}
export async function inspectPlan(cwd: string) {
  try { return await inspectValidPlan(cwd) } catch (error) {
    if (!(error instanceof NamedError || error instanceof SyntaxError || error instanceof z.ZodError)) throw error
    return { revision: 0, task: null, taskSatisfied: null, nodes: [], next: [], procedures: [],
      message: `Repair the setup plan: ${error.message}. Device operations remain available.` }
  }
}
export async function recordOutcome(cwd: string, id: string, input: Outcome, revision: number) {
  const file = await location(cwd, "setup/plan.json")
  return serialized(file, async () => {
    const plan = await readPlan(cwd)
    if (!plan || plan.revision !== revision) fail("Plan changed or is missing; read it again")
    const node = plan.nodes.find(node => node.id === id)
    if (!node) fail(`Unknown node ${id}`)
    const outcome = Outcome.parse(input)
    const inputs = await inspectFacts(cwd, await requirements(cwd, node))
    const outputs = await inspectFacts(cwd, node.outputs)
    const evidence = await inspectFacts(cwd, outcome.evidence.map(path => ({ kind: "file", path })))
    if (evidence.missing.length) fail("Evidence files must exist")
    if (outcome.status === "done") {
      const view = await inspectPlan(cwd)
      if (inputs.missing.length || outputs.missing.length || node.dependsOn.some(id => view.nodes.find(node => node.id === id)?.status !== "done"))
        fail("Cannot complete a node with missing facts, outputs or prerequisites")
      for (const artifact of outcome.evidence) {
        if (!/\/result(?:-\d+)?\.json$/.test(artifact)) continue
        const text = await optionalText(await location(cwd, artifact))
        const result = z.object({
          quality: z.enum(["passed", "warning", "failed", "not-evaluated"]).optional(),
          computation: z.enum(["failed", "succeeded"]).optional(), node: ID.optional(),
          inputs: z.array(Fact).optional(), fingerprint: z.string().optional(),
          dependencies: z.string().optional(),
          resolved: z.array(z.object({ device: ID, pointer: Pointer, value: z.unknown() })).default([]),
        }).parse(text ? JSON.parse(text) : undefined)
        if (result.quality === "failed" || result.computation === "failed") fail("Failed computation or quality cannot establish completion")
        if (result.node && result.node !== node.id) fail("Result belongs to a different plan node")
        if (result.dependencies && result.dependencies !== dependencies(plan, node)) fail("Computation prerequisites changed; start a new attempt")
        if (result.inputs && result.fingerprint && (await inspectFacts(cwd, result.inputs)).hash !== result.fingerprint)
          fail("Computation inputs changed; reassess before completing the node")
        const expected = result.resolved.map(field => ({ kind: "profile" as const, ...field }))
          .filter(field => node.outputs.some(output => covers(output, field)))
        if ((await inspectFacts(cwd, expected)).missing.length) fail("Apply and verify the solver's resolved output values first")
      }
    }
    const receipt = { ...outcome, at: new Date().toISOString(), definition: digest(node), inputs: inputs.hash,
      outputs: outputs.hash, evidenceHash: evidence.hash, dependencies: dependencies(plan, node) }
    currentSignal()?.throwIfAborted()
    await atomicJSON(file, { ...plan, revision: revision + 1, receipts: { ...plan.receipts, [id]: receipt } })
    return inspectPlan(cwd)
  })
}
export function renderSetup(view: Awaited<ReturnType<typeof inspectPlan>>, full = false) {
  const nodes = full ? view.nodes : view.nodes.filter(node => node.relevance === "required-now" && node.status !== "done")
  return JSON.stringify({ revision: view.revision, task: view.task,
    taskSatisfied: view.taskSatisfied, message: "message" in view ? view.message : view.task ? undefined : "No active task; calibration is deferred and operations remain available.",
    next: view.next, missing: "missing" in view ? view.missing : [], nodes,
    deferred: view.nodes.filter(node => node.relevance !== "required-now").length,
    ...(full ? { procedures: view.procedures } : {}) }, null, 2)
}
