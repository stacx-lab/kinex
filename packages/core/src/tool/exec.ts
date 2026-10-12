import { z } from "zod"
import { define } from "./tool.ts"
import { runScript } from "./python-runner.ts"
import DESCRIPTION from "./exec.txt"

export const ExecTool = define("exec", {
  description: DESCRIPTION,
  parameters: z.strictObject({
    description: z.string().optional().describe("Short lowercase description of the task, for display"),
    python: z.string().min(1).optional().describe("Python source, including multiline scripts; provide exactly one of python or file"),
    file: z.string().min(1).optional().describe("Script path, relative to the working directory or absolute"),
    args: z.record(z.string(), z.unknown()).default({}).describe("Values available through kinex.args()"),
    argv: z.array(z.string()).default([]).describe("Script command-line arguments"),
    interpreter: z.string().min(1).optional().describe("Python executable; defaults to the managed Kinex Python environment"),
    timeout_s: z.number().positive().max(2_147_483).default(120),
  }).refine(input => (input.python !== undefined) !== (input.file !== undefined), "provide exactly one of python or file"),
  execute: runScript,
})
