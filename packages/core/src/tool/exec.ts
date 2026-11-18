import { z } from "zod"
import { define } from "./tool.ts"
import { runExec } from "./python-runner.ts"
import DESCRIPTION from "./exec.txt"

export const ExecTool = define("exec", {
  description: DESCRIPTION,
  parameters: z.strictObject({
    description: z.string().optional().describe("Short lowercase description of the task, for display"),
    python: z.string().min(1).optional().describe("Source of a complete program; provide exactly one of python or file"),
    file: z.string().min(1).optional().describe("Path of a saved program, relative to the working directory or absolute"),
    args: z.record(z.string(), z.unknown()).default({}).describe("Values the program reads with kinex.args()"),
    argv: z.array(z.string()).default([]).describe("The program's command-line arguments"),
    timeout_s: z.number().positive().max(2_147_483).default(120),
  }).refine(input => (input.python !== undefined) !== (input.file !== undefined), "provide exactly one of python or file"),
  execute: runExec,
})
