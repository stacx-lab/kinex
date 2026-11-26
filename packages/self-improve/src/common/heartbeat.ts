// pi-subagents takes a background sub-agent that writes nothing for a minute for
// one that needs attention, and of a job's process it sees only what the process
// writes. So that a job at work is not taken for a stuck one, its process writes a
// newline to standard error this often until it ends. Only a newline: the standard
// error of a command that fails, trimmed, is what pi-subagents tells the session as
// its error, and this leaves that as it was. Standard output stays the one line the
// session is told at the end.
export const BEAT_MS = 30_000

/** Writes a newline with `write` every `every` ms; the function it returns stops it. */
export function heartbeat(write: (text: string) => void, every = BEAT_MS): () => void {
  const timer = setInterval(() => write("\n"), every)
  // It keeps no process alive: the job's own work does.
  timer.unref()
  return () => clearInterval(timer)
}
