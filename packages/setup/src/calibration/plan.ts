import { readinessPlan, type ItemStatus, type PlanItem, itemSelector } from "@kinex/core/device/profile/readiness"
import GUIDANCE from "./guidance.txt"

const guidance: Record<string, string> = JSON.parse(GUIDANCE)
function describe(item: PlanItem) {
  const section = item.id.split(":")[0]!
  const type = item.device?.type
  const family = type && ["detection", "segmentation"].includes(type) ? "model" : type
  return { ...item, how: guidance[item.id] ?? guidance[`${section}:${type}`]
    ?? guidance[`${section}:${family}`] ?? guidance[section] ?? guidance.default! }
}

export async function calibrationPlan(cwd: string) {
  const plan = await readinessPlan(cwd)
  return { ...plan, items: plan.items.map(describe), next: plan.next.map(describe), needed: plan.needed.map(describe) }
}
export type CalibrationPlan = Awaited<ReturnType<typeof calibrationPlan>>
export { itemSelector }
const MARKS: Record<ItemStatus, string> = { done: "✓", "needs-calibration": "◐", ready: "▶", blocked: "·" }

// Compact by default: the plan is re-rendered after every profile_write, so done
// and blocked items collapse to one id-list line each — only actionable items
// carry detail. `full` restores the per-item table.
export function renderPlan(plan: CalibrationPlan, options: { full?: boolean } = {}): string {
  const lines: string[] = []
  const header = plan.robotID ? `Calibration plan for ${plan.robotID} (${plan.platform})` : "Calibration plan (no robot onboarded yet)"
  lines.push(
    `${header}: ${plan.counts.done}/${plan.items.length} done, ${plan.counts.ready} ready, ${plan.counts["needs-calibration"]} need calibration, ${plan.counts.blocked} blocked`,
  )
  const actionable = new Set<ItemStatus>(["ready", "needs-calibration"])
  for (const item of plan.items) {
    if (!options.full && !actionable.has(item.status)) continue
    const optional = item.optional ? " (optional)" : ""
    const deps = item.dependsOn.length > 0 ? ` [needs: ${item.dependsOn.join(", ")}]` : ""
    lines.push(`${MARKS[item.status]} ${item.id}${optional} — ${item.title}`)
    if (item.detail) lines.push(`    ${item.status === "done" ? item.detail : `${item.detail}${item.status === "blocked" ? deps : ""}`}`)
    if (item.status === "ready") lines.push(`    how: ${item.how}`)
  }
  if (!options.full) {
    const done = plan.items.filter((item) => item.status === "done")
    const blocked = plan.items.filter((item) => item.status === "blocked")
    if (done.length > 0) lines.push(`✓ done: ${done.map((item) => item.id).join(", ")}`)
    if (blocked.length > 0) lines.push(`· blocked: ${blocked.map((item) => item.id).join(", ")} (full=true for their dependencies)`)
  }
  const taskReady = plan.items.find((item) => item.id === "task-ready")?.status === "done"
  if (plan.needed.length > 0)
    lines.push(
      `needs calibration: ${plan.needed.map((item) => (item.device ? `${item.id} [${itemSelector(item)}]` : item.id)).join(", ")} — run /calibrate to resolve these with the matching calibration skills`,
    )
  if (plan.next.length > 0) lines.push(`next: ${plan.next.map((item) => item.id).join(", ")}`)
  else if (taskReady) lines.push("next: nothing required — the robot is task-ready")
  else if (plan.needed.length > 0) lines.push("next: no interview items remain; run /calibrate to work the queue above")
  else lines.push("next: no items are actionable; resolve missing dependencies above")
  return lines.join("\n")
}
