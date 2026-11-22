import { line, type Jobs, type Report } from "./index.ts"

// The same operations for a model. A tool here is a plain definition, a name, a
// description, the JSON Schema of its arguments and a function, which every agent
// host can register in its own way.
export interface ToolResult { title: string; text: string; isError?: boolean }
export interface Tool<Args = Record<string, unknown>> {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Args, signal: AbortSignal): Promise<ToolResult>
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required })

export interface WaitArgs { ids?: string[]; mode?: "all" | "any"; timeout_s?: number }
export interface StopArgs { id: string }

/** The tools that collect, list and stop jobs; a host registers the ones its session needs. */
export function tools(jobs: Jobs, { prefix }: { prefix: string }): { wait: Tool<WaitArgs>; status: Tool<object>; stop: Tool<StopArgs> } {
  return {
    wait: {
      name: `${prefix}_wait`,
      description: "Wait for started work to end and return one line for each: how it ended and where its record is. Waits at most timeout_s; call again while it says running.",
      parameters: object({
        ids: { type: "array", items: { type: "string" }, description: "default: everything started that has not ended" },
        mode: { type: "string", enum: ["all", "any"], default: "all", description: "return when all have ended, or as soon as one has" },
        timeout_s: { type: "number", exclusiveMinimum: 0, default: 3600 },
      }),
      async execute(args, signal) {
        const cards = await jobs.wait(args.ids, { mode: args.mode ?? "all", timeoutS: args.timeout_s ?? 3600, signal })
        return { title: `${cards.filter(card => card.state === "ended").length}/${cards.length} ended`, text: cards.map(line).join("\n") || "Nothing is running." }
      },
    },
    status: {
      name: `${prefix}_status`,
      description: "Everything started so far, oldest first: queued, running or ended, with one line for each.",
      parameters: object({}),
      execute: async () => ({ title: `${jobs.list().length} started`, text: jobs.list().map(line).join("\n") || "Nothing was started." }),
    },
    stop: {
      name: `${prefix}_stop`,
      description: "Stop one piece of started work; its line then says stopped.",
      parameters: object({ id: { type: "string" } }, ["id"]),
      async execute(args) {
        jobs.stop(args.id)
        return { title: `${args.id} stopped`, text: `Stopping ${args.id}.` }
      },
    },
  }
}

export interface StartOptions<Args> {
  name: string
  description: string
  parameters: Record<string, unknown>
  lane?: string
  /** The job these arguments ask for: its id, where its record will be, and the work. */
  job(args: Args): { id: string; record?: string; run(signal: AbortSignal): Promise<Report | void> }
}

/** Turns one kind of work into a tool that starts it and returns at once; the wait tool collects it. */
export function startTool<Args>(jobs: Jobs, options: StartOptions<Args>): Tool<Args> {
  return {
    name: options.name, description: options.description, parameters: options.parameters,
    async execute(args) {
      const card = jobs.start({ ...options.job(args), ...(options.lane ? { lane: options.lane } : {}) })
      return { title: `${card.id} started`, text: `Started ${card.id}${card.state === "queued" ? ", queued behind the others in its lane" : ""}.` }
    },
  }
}
