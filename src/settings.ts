import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent"
import { lockSync } from "proper-lockfile"

export function paths() {
  const config = process.env.KINEX_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "kinex")
  const data = process.env.KINEX_DATA_DIR ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "kinex")
  return { config, data, agent: path.join(config, "agent"), state: path.join(data, "agent") }
}

export function sessionDirectory(cwd: string): string {
  return path.join(paths().state, "sessions", createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 24))
}

export function settings(cwd: string): SettingsManager {
  const global = path.join(paths().agent, "settings.json")
  const project = path.join(cwd, ".kinex", "agent", "settings.json")
  const manager = SettingsManager.fromStorage({
    withLock(scope, update) {
      const file = scope === "global" ? global : project
      const effective = (text: string | undefined) => {
        const parsed: unknown = text ? JSON.parse(text) : {}
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Settings must be an object: ${file}`)
        for (const key of ["packages", "extensions", "skills", "prompts", "themes"]) {
          const value: unknown = Reflect.get(parsed, key)
          if (value !== undefined && (!Array.isArray(value) || value.length)) throw new Error(`${key} is not supported in Kinex agent settings; use Kinex workspace content`)
        }
        return JSON.stringify({ ...(scope === "global" ? {
          defaultTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
          quietStartup: true, lastChangelogVersion: VERSION, enableInstallTelemetry: false, enableAnalytics: false,
        } : {}), ...parsed })
      }
      // Reading settings must not create .kinex in a nested directory and
      // accidentally shadow an ancestor's robotics workspace.
      if (!existsSync(file) && update(effective(undefined)) === undefined) return
      mkdirSync(path.dirname(file), { recursive: true })
      const unlock = lockSync(file, { realpath: false })
      try {
        const current = existsSync(file) ? readFileSync(file, "utf8") : undefined
        const next = update(effective(current))
        if (next === undefined || next === current) return
        const temporary = `${file}.${randomUUID()}.tmp`
        writeFileSync(temporary, next, { mode: 0o600 })
        renameSync(temporary, file)
      } finally { unlock() }
    },
  }, { projectTrusted: true })
  return manager
}
