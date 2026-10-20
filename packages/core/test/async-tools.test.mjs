import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("async builtins preserve typed motion, world timing and frame composition", () => {
  execFileSync(process.env.PYTHON ?? "python3", [fileURLToPath(new URL("./async_tools.py", import.meta.url))], {
    env: { ...process.env, PYTHONPATH: fileURLToPath(new URL("../assets/python", import.meta.url)), PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
  })
})
