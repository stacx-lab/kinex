import type { Def } from "@kinex/core"

// A self-improvement strategy: a way of practising simulated tasks and keeping
// what is learned, with a command of its own. Its runs live in a workspace's
// .kinex/self-improve/<name>/runs/, its children run in the sandbox, its episodes
// come from kinex-sim, and its jobs run as background sub-agents: common/ gives
// every strategy these. What it practises, how it decides the next step and what
// a run leaves are its own, in strategies/<name>/. integration.ts makes each
// strategy's command and tools, and main.ts runs its jobs.

/** What a job's process is given: its run's folder, the words of the call that started it, and what ends it. */
export interface JobCall {
  root: string
  /** The words of the call, by name: those the job kind names. */
  words: Record<string, string>
  signal: AbortSignal
  /** Ends the job this many seconds (and an hour's slack) from now; called once the job is admitted. */
  within(seconds: number): void
}

/** A kind of job a strategy runs as a background sub-agent: what main.ts does for it. */
export interface JobKind {
  /** What the job is called in what it says, such as "trial". */
  what: string
  /** The words of its call beside run=<folder>, such as task=<id>. */
  words?: readonly string[]
  /** Does the job and returns the line the session is told. A job it does not have to do throws Refused. */
  run(call: JobCall): Promise<string>
}

export interface Strategy {
  /** Its command, its folder under .kinex/self-improve/, and the prefix of its job agents. */
  name: string
  description: string
  /** What its command takes, for completion and its usage line. */
  arguments: string
  /** The tool the scheduling session calls whenever one of its jobs has ended. */
  next: string
  /** Every tool it may give a session, which the host reserves. */
  toolNames: readonly string[]
  /** The tools of its child in `role`, or without one of the user's session while it plans or schedules one of its runs. */
  tools(role?: string): Def[]
  /** `/<name> <request>`: the prompt the session plans a run with. The user approves the plan before anything exists. */
  plan(request: string): string
  /** `/<name> resume`: writes what the run's jobs are started with and returns what the session is told. */
  resume(root: string): Promise<string>
  /** `/<name> status`: what the user reads of a run. */
  status(root: string): Promise<string>
  /** The folders its runs keep their jobs in, which `/<name> stop` ends. */
  jobFolders(root: string): string[]
  /** Its jobs by kind, as main.ts runs them. */
  jobs: Record<string, JobKind>
  /** Its own subcommands beside status, resume and stop: each takes the words after its name and returns what the user reads. */
  subcommands?: Record<string, (words: string[], workspace: { directory: string; kinex: string }) => Promise<string>>
  /** More completions after its command, given the workspace's newest run of it. */
  choices?(root: string | undefined): Promise<string[]>
  /** Context sections of every session in the workspace `directory`, such as an installed brief; an empty one is a removed one. */
  context?(directory: string): Promise<Record<string, string>>
}
