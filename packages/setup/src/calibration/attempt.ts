import path from "node:path"
import { randomUUID } from "node:crypto"
import { copyFile, mkdir } from "node:fs/promises"
import { z } from "zod"
import { currentSignal } from "@kinex/core/scope"
import { Fact, ID } from "../planning/schema.ts"
import { digest, inspectFacts, location, optionalText, atomicJSON, fail } from "../planning/facts.ts"
import { readPlan, inspectPlan, dependencies } from "../planning/plan.ts"
import { requirements, procedures } from "../planning/procedures.ts"

export const AttemptInput = z.strictObject({
  run: ID.optional(), node: ID.optional(), procedure: z.string().min(1).optional(),
  bindings: z.record(ID, ID).optional(), inputs: z.array(Fact).default([]),
})
export type AttemptInput = z.infer<typeof AttemptInput>
export const Manifest = z.strictObject({
  version: z.literal(1), id: ID, node: ID.optional(), definition: z.string().optional(),
  procedure: z.string(), bindings: z.record(ID, ID), inputs: z.array(Fact), fingerprint: z.string(), createdAt: z.string(),
  dependencies: z.string().optional(),
})
export type Attempt = z.infer<typeof Manifest>
export async function attempt(cwd: string, input: AttemptInput): Promise<Attempt> {
  if (input.run) {
    const text = await optionalText(await location(cwd, `calib/${input.run}/manifest.json`))
    if (!text) fail(`Unknown calibration attempt ${input.run}`)
    const existing = Manifest.parse(JSON.parse(text))
    if ((input.node && input.node !== existing.node) || (input.procedure && input.procedure !== existing.procedure) ||
      (input.bindings && digest(input.bindings) !== digest(existing.bindings))) fail("Attempt participants and procedure are immutable")
    if (input.inputs.length) fail("Reuse an attempt by run ID; its inputs are immutable")
    if ((await inspectFacts(cwd, existing.inputs)).hash !== existing.fingerprint) fail("Attempt inputs changed; start a new attempt")
    if (existing.node) {
      const plan = await readPlan(cwd)
      const node = plan?.nodes.find(node => node.id === existing.node)
      if (!plan || !node || digest(node) !== existing.definition || dependencies(plan, node) !== existing.dependencies)
        fail("Plan node or prerequisites changed; start a new attempt")
    }
    return existing
  }
  const plan = input.node ? await readPlan(cwd) : undefined
  const node = plan?.nodes.find(node => node.id === input.node)
  if (input.node && !node) fail(`Unknown plan node ${input.node}`)
  if (node) {
    const state = (await inspectPlan(cwd)).nodes.find(entry => entry.id === node.id)
    if (state?.status === "blocked" || state?.status === "needs-input") fail(`Resolve prerequisites for ${node.id} first`)
  }
  const procedure = node?.skill ?? input.procedure
  if (!procedure) fail("Provide a plan node or procedure and bindings for a new attempt")
  const bindings = node?.bindings ?? input.bindings ?? {}
  if ((input.procedure && input.procedure !== procedure) || (node && input.bindings && digest(input.bindings) !== digest(bindings)))
    fail("Attempt must use the plan node's procedure and participants")
  const selected = (await procedures(cwd)).find(skill => skill.name === procedure)
  if (!selected) fail(`Unknown procedure ${procedure}`)
  const inputs = await requirements(cwd, node ?? { id: "attempt", title: procedure, kind: "calibrate", skill: procedure,
    bindings, dependsOn: [], outputs: [], optional: false, inputs: input.inputs })
  const facts = await inspectFacts(cwd, inputs)
  if (facts.missing.length) fail(`Missing attempt inputs: ${JSON.stringify(facts.missing)}`)
  return { version: 1, id: randomUUID(), ...(node && plan ? { node: node.id, definition: digest(node), dependencies: dependencies(plan, node) } : {}),
    procedure, bindings, inputs, fingerprint: facts.hash, createdAt: new Date().toISOString() }
}
export async function saveAttempt(cwd: string, run: Attempt) {
  currentSignal()?.throwIfAborted()
  const dir = await location(cwd, `calib/${run.id}`)
  await mkdir(path.join(dir, "artifacts"), { recursive: true })
  const manifest = path.join(dir, "manifest.json")
  if (!await optionalText(manifest)) await atomicJSON(manifest, run)
  return dir
}
export async function archive(cwd: string, run: Attempt, file: string) {
  const dir = await saveAttempt(cwd, run)
  const destination = path.join(dir, "artifacts", `${randomUUID()}${path.extname(file)}`)
  await copyFile(file, destination)
  return destination
}
