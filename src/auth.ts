import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs"
import path from "node:path"
import { lock } from "proper-lockfile"
import { NamedError } from "@kinex/core/util/error"
import { shortID } from "@kinex/core/util/id"

// Pi-created child sessions use agentDir/auth.json. Keep the credentials in
// Kinex data storage, but use this same entrypoint (and lock path) in the host.
export async function prepareAuthPath(agent: string, state: string): Promise<string> {
  const auth = path.resolve(agent, "auth.json")
  const target = path.resolve(state, "auth.json")
  if (auth === target) return auth
  mkdirSync(path.dirname(auth), { recursive: true, mode: 0o700 })
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const linked = () => lstatSync(auth, { throwIfNoEntry: false })?.isSymbolicLink()
    && path.resolve(path.dirname(auth), readlinkSync(auth)) === target
  // An existing bridge needs no mutation or wait for another session's refresh.
  if (linked()) return auth
  const unlock = await lock(auth, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 100 } })
  try {
    if (linked()) return auth
    const existing = lstatSync(auth, { throwIfNoEntry: false })
    if (existing) {
      // A child SDK session may already have created an empty auth file.
      if (!existing.isFile() || !/^\s*\{\s*\}\s*$/.test(readFileSync(auth, "utf8"))) {
        throw new NamedError("AuthPathConflict", `Cannot link ${auth} to ${target}: the SDK auth path already contains credentials or a different filesystem entry. Reconcile it before restarting Kinex; neither path was changed.`)
      }
    }
    const temporary = `${auth}.${shortID()}.tmp`
    try {
      symlinkSync(path.relative(path.dirname(auth), target), temporary, "file")
      renameSync(temporary, auth)
    } finally { rmSync(temporary, { force: true }) }
    return auth
  } finally { await unlock() }
}
