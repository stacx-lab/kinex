import { spawnProcess } from "@kinex/core/util/process"
import type { Result } from "@kinex/core"
import { Assets } from "../assets.ts"

export function needsAuthentication(value: unknown): boolean {
  return !!value && typeof value === "object" && "needs" in value && Array.isArray(value.needs)
    && value.needs.some(need => need && typeof need === "object" && "reason" in need && need.reason === "sudo_authentication")
}

export async function installApt(packages: string[], directory: string, signal: AbortSignal, interactive = false): Promise<Result> {
  // Authentication only executes installed assets, with no workspace/site imports.
  const proc = spawnProcess(["/usr/bin/python3", "-S", Assets.python("kinex_ros", "bundle_install.py"), "--install",
    ...(interactive ? ["--interactive"] : []), "--", ...packages], {
    cwd: directory, group: true, signal, stdin: interactive ? "inherit" : "pipe",
    env: { ...process.env, PYTHONHOME: undefined, PYTHONPATH: Assets.python() },
  })
  if (!interactive) proc.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  signal.throwIfAborted()
  let details: unknown
  try { details = JSON.parse(stdout) } catch { details = undefined }
  return { title: "Install system packages", output: stdout.trim() || stderr.trim() || `Installer exited with code ${code}`,
    metadata: { result: details }, isError: code !== 0 }
}
