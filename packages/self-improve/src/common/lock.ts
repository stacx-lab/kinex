import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

// Jobs are separate processes, so what only one of them may do at a time is
// guarded by a folder: creating it is taking the lock, and it names its holder,
// so that a lock whose holder died is taken over.
export const running = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM" }
}

/** Runs `work` while this process alone holds the lock `directory`. */
export async function locked<T>(directory: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await mkdir(path.dirname(directory), { recursive: true })
  const holder = path.join(directory, "pid")
  for (;;) {
    signal?.throwIfAborted()
    const taken = await mkdir(directory).then(() => true, (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
      throw error
    })
    if (taken) break
    // A holder that has not written its name yet is given the moment it needs.
    const pid = Number(await readFile(holder, "utf8").catch(() => ""))
    if (pid && !running(pid)) { await rm(directory, { recursive: true, force: true }); continue }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  try {
    await writeFile(holder, String(process.pid))
    return await work()
  } finally { await rm(directory, { recursive: true, force: true }) }
}
