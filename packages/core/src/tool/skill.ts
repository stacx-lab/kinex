import { z } from "zod"
import { define } from "./tool.ts"
import { loadSkill } from "../skill/index.ts"
import { readinessPlan, itemSelector } from "../device/profile/readiness.ts"
import DESCRIPTION from "./skill.txt"

// A `requires` selector is met when some DONE plan item matches it — by exact
// id (access:sam3) or by its <section>:<device type> selector (access:model).
// Advisory: unmet items produce a warning, never a refusal — setup skills must
// stay loadable on an uncalibrated robot.
async function unmetRequires(cwd: string, requires: string | undefined): Promise<string[]> {
  if (!requires) return []
  const plan = await readinessPlan(cwd)
  const done = plan.items.filter((item) => item.status === "done")
  return requires
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean)
    .filter((selector) => !done.some((item) => item.id === selector || itemSelector(item) === selector))
}

export const SkillTool = define("skill", {
  description: DESCRIPTION,
  parameters: z.object({
    name: z.string().describe("name of the skill to load"),
  }),
  execute: async (args, ctx) => {
    const skill = await loadSkill(ctx.directory, args.name)
    if (!skill) return { title: args.name, output: `unknown skill "${args.name}"`, }
    const unmet = await unmetRequires(ctx.directory, skill.info.requires)
    const output = [
      ...(unmet.length > 0
        ? [
            `WARNING: this skill requires calibration items that are not done yet: ${unmet.join(", ")} — resolve them before relying on the result.`,
          ]
        : []),
      `<skill_content name="${args.name}">`,
      skill.content,
      `</skill_content>`,
      `Base directory for this skill: ${skill.info.directory}`,
    ].join("\n")
    return { title: `skill: ${args.name}`, output }
  },
})
