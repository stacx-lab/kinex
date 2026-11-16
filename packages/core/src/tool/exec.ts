import { z } from "zod"
import { define } from "./tool.ts"
import { runExec } from "./python-runner.ts"
import DESCRIPTION from "./exec.txt"

const sources = ["python", "file", "program"] as const

export const ExecTool = define("exec", {
  description: DESCRIPTION,
  parameters: z.strictObject({
    description: z.string().optional().describe("Short lowercase description of the task, for display"),
    python: z.string().min(1).optional().describe("Python source run as the body of an async function: it may await and return"),
    file: z.string().min(1).optional().describe("Path of a Python file outside lib whose main function runs, relative to the working directory or absolute"),
    program: z.string().regex(/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/).optional().describe("A kinex.lib function as module.function, found with the lib tool"),
    args: z.record(z.string(), z.unknown()).default({}).describe("Keyword arguments of the program or the file's main; python source reads them as args"),
    argv: z.array(z.string()).default([]).describe("Command-line arguments of file"),
    timeout_s: z.number().positive().max(2_147_483).default(120),
  }).refine(input => sources.filter(source => input[source] !== undefined).length === 1, "provide exactly one of python, file or program"),
  execute: runExec,
})
