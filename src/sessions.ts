import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { initTheme, SessionManager, SessionSelectorComponent, type SessionInfo } from "@earendil-works/pi-coding-agent"
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui"
import { paths, sessionDirectory, settings } from "./settings.ts"

export async function listKinexSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
  const root = path.join(paths().state, "sessions")
  const directories = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  })
  const sessions = await Promise.all(directories.filter(entry => entry.isDirectory()).map(entry =>
    SessionManager.listAll(path.join(root, entry.name), undefined, signal)))
  return sessions.flat().sort((left, right) => right.modified.getTime() - left.modified.getTime())
}

export async function resolveSession(reference: string, cwd: string): Promise<string> {
  const file = reference.startsWith("~/") ? path.join(homedir(), reference.slice(2)) : path.resolve(cwd, reference)
  if (existsSync(file)) return file
  const current = await SessionManager.list(cwd, sessionDirectory(cwd))
  const select = (sessions: SessionInfo[]) => {
    const exact = sessions.filter(session => session.id === reference)
    const matches = exact.length ? exact : sessions.filter(session => session.id.startsWith(reference))
    if (matches.length > 1) throw new Error(`Ambiguous Kinex session: ${reference}; use a full ID or file path`)
    return matches[0]?.path
  }
  const match = select(current) ?? select(await listKinexSessions())
  if (!reference || !match) throw new Error(`Unknown Kinex session: ${reference}`)
  return match
}

/** Use Pi's selector UI, with loaders for Kinex's existing workspace session directories. */
export async function selectSession(cwd: string): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("--resume requires a terminal; use --session <id-or-file> or --continue")
  const manager = settings(cwd)
  const errors = manager.drainErrors()
  if (errors.length) throw new Error(errors.map(error => String(error.error)).join("\n"))
  initTheme(manager.getTheme(), false)
  const ui = new TuiMainScreen(new ProcessTerminal(), manager.getShowHardwareCursor(), paths().agent)
  ui.setClearOnShrink(manager.getClearOnShrink())
  return new Promise(resolve => {
    const finish = (selected?: string) => { ui.stop(); resolve(selected) }
    const selector = new SessionSelectorComponent(
      (progress, signal) => SessionManager.list(cwd, sessionDirectory(cwd), progress, signal),
      (_progress, signal) => listKinexSessions(signal),
      finish, () => finish(), () => finish(), () => ui.requestRender(),
      { showRenameHint: false },
    )
    ui.addChild(selector)
    ui.setFocus(selector.getSessionList())
    ui.start()
  })
}
