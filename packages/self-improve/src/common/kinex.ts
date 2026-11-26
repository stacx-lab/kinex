// The Kinex a child session runs: the one this process is, or, in a job's own
// process, the one that scheduled the run.
export const kinex: { entry: string | undefined; args: readonly string[] } = { entry: process.argv[1], args: process.argv.slice(2) }

// A child runs on the model its Kinex was started with: --model, --provider and
// --thinking pass on, and without them the child takes the same settings defaults.
export function modelFlags(args: readonly string[] = kinex.args): string[] {
  const flags: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") break
    const name = ["--model", "--provider", "--thinking"].find(flag => arg === flag || arg.startsWith(`${flag}=`))
    if (!name) continue
    const value = arg === name ? args[++index] : arg.slice(name.length + 1)
    if (value) flags.push(name, value)
  }
  return flags
}
