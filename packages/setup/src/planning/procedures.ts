import path from "node:path"
import { z } from "zod"
import { listSkills } from "@kinex/core/skill/index"
import { optionalText, fail, profile, pointer, location } from "./facts.ts"
import { ID, Pointer, type Fact, type PlanNode } from "./schema.ts"

const Requirement = z.strictObject({ role: ID, pointer: Pointer, value: z.unknown().optional() })
export const Procedure = z.strictObject({
  version: z.literal(1),
  roles: z.record(ID, z.strictObject({ types: z.array(z.string()).min(1), optional: z.boolean().default(false) })),
  distinct: z.array(z.array(ID).min(2)).default([]),
  links: z.array(z.strictObject({ child: ID, parent: ID })).default([]),
  requires: z.array(Requirement).default([]), produces: z.array(Requirement).default([]),
  computes: z.array(z.string()).default([]), quality: z.string().min(1),
}).superRefine((value, ctx) => {
  const referenced = [...value.requires.map(item => item.role), ...value.produces.map(item => item.role),
    ...value.distinct.flat(), ...value.links.flatMap(link => [link.child, link.parent])]
  for (const role of referenced) if (!Object.hasOwn(value.roles, role))
    ctx.addIssue({ code: "custom", message: `Unknown procedure role ${role}` })
})
export type Procedure = z.infer<typeof Procedure>
export async function procedures(cwd: string) {
  return Promise.all((await listSkills(cwd)).map(async skill => {
    const text = await optionalText(path.join(skill.directory, "procedure.json"))
    let descriptor: Procedure | undefined, problem: string | undefined
    if (text !== undefined) {
      try { descriptor = Procedure.parse(JSON.parse(text)) } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error
        problem = `Invalid procedure descriptor: ${error.message}`
      }
    }
    return { name: skill.name, description: skill.description, directory: skill.directory, descriptor, problem }
  }))
}
export async function requirements(cwd: string, node: PlanNode, catalog?: Awaited<ReturnType<typeof procedures>>): Promise<Fact[]> {
  const selected = (catalog ?? await procedures(cwd)).find(skill => skill.name === node.skill)
  if (!selected) fail(`Unknown skill ${node.skill}`)
  if (selected.problem) fail(`${node.id}: ${selected.problem}`)
  const descriptor = selected.descriptor
  if (!descriptor) return node.inputs
  for (const [role, spec] of Object.entries(descriptor.roles)) {
    const device = node.bindings[role]
    if (!device) {
      if (spec.optional) continue
      fail(`${node.id}: bind role ${role}`)
    }
    const data = await profile(cwd, device)
    if (data !== undefined && !spec.types.includes(String(pointer(data, "/type"))))
      fail(`${node.id}: ${device} is not a ${spec.types.join("/")} for ${role}`)
  }
  for (const role of Object.keys(node.bindings)) if (!descriptor.roles[role]) fail(`${node.id}: unknown role ${role}`)
  for (const group of descriptor.distinct) {
    const devices = group.map(role => node.bindings[role]).filter(value => value !== undefined)
    if (new Set(devices).size !== devices.length) fail(`${node.id}: roles ${group.join(", ")} must use different devices`)
  }
  for (const link of descriptor.links) {
    const child = node.bindings[link.child], parent = node.bindings[link.parent]
    if (!child || !parent) continue
    const actual = pointer(await profile(cwd, child), "/extrinsics/mount/parent")
    if (actual !== undefined && actual !== "???" && actual !== parent) fail(`${node.id}: ${child} is attached to ${actual}, not ${parent}`)
  }
  const inputs: Fact[] = [...node.inputs,
    ...Object.values(node.bindings).map(device => ({ kind: "profile" as const, device, pointer: "/type" })),
    ...descriptor.requires.flatMap(required => {
    const device = node.bindings[required.role]
    return device ? [{ kind: "profile" as const, device, pointer: required.pointer,
      ...(Object.hasOwn(required, "value") ? { value: required.value } : {}) }] : []
  })]
  // A URDF reference alone is insufficient: changing its bytes changes geometry.
  for (const input of [...inputs]) {
    if (input.kind !== "profile" || !input.device || !input.pointer.startsWith("/intrinsics/model")) continue
    const data = await profile(cwd, input.device)
    const modelPath = pointer(data, "/intrinsics/model/path")
    if (pointer(data, "/intrinsics/model/format") === "urdf" && typeof modelPath === "string" && modelPath !== "???")
      inputs.push({ kind: "file", path: path.resolve(await location(cwd, `devices/${input.device}`), modelPath) })
  }
  return inputs
}
