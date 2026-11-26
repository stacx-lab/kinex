import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { machineDir } from "./layout.ts"
import { locked } from "./lock.ts"
import type { SessionExit } from "./session.ts"
import type { Verdict } from "./sim.ts"

// A worker in a launched episode, as every strategy runs one: started in its turn
// on this machine, and judged by the simulator.

// Work that must not begin at the same moment takes turns: each worker's turn
// comes no sooner than `gapS` after the one before it, whichever job, strategy and
// workspace it is in, since all of them load devices on this machine.
export async function spaced(gapS: number, signal?: AbortSignal): Promise<void> {
  const last = path.join(machineDir(), ".start")
  const mine = await locked(path.join(machineDir(), ".start.lock"), async () => {
    const turn = Math.max(Date.now(), Number(await readFile(last, "utf8").catch(() => "")) + gapS * 1000 || 0)
    await writeFile(last, String(turn))
    return turn
  }, signal)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, mine - Date.now())))
}

// Whether an episode ran is the simulator's to say, not the worker's exit code: a
// worker that exits non-zero after its episode advanced (a device that loaded
// late, say) was still judged, and its exit is kept as a note. Only a worker
// that failed before the simulation moved leaves an episode that did not run.
export function judged(session: SessionExit, verdict: Verdict): SessionExit & { note?: string; error?: string } {
  if (session.status !== "error") return session
  const exit = `worker exited ${session.exitCode}`
  return verdict.steps === 0 ? { ...session, error: `${exit} before the simulation advanced; see output.log` }
    : { ...session, status: "done", note: `${exit}; see output.log` }
}
