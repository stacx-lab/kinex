import { z } from "zod"
import { define } from "./tool.ts"
import { loadSkill } from "../skill/index.ts"
import DESCRIPTION from "./skill.txt"

export const SkillTool = define("skill", {
  description: DESCRIPTION,
  parameters: z.object({
    name: z.string().describe("name of the skill to load"),
  }),
  execute: async (args, ctx) => {
    const skill = await loadSkill(ctx.directory, args.name)
    if (!skill) return { title: args.name, output: `unknown skill "${args.name}"`, }
    const output = [
      `<skill_content name="${args.name}">`,
      skill.content,
      `</skill_content>`,
      `Base directory for this skill: ${skill.info.directory}`,
    ].join("\n")
    return { title: `skill: ${args.name}`, output }
  },
})
