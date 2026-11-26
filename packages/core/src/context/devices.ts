import { ProfileStore } from "../device/profile/store.ts"
import { pythonEnvironment } from "../python/environment.ts"
import { pythonLaunch } from "../python/launch.ts"
import { spawnProcess } from "../util/process.ts"

type Fields = Record<string, string>
interface Interface { interface: Record<string, Fields>; types: Record<string, Fields> }

// Free-form operations carry JSON objects their descriptions define; their ROS envelope says nothing.
const FREE = new Set(["custom_interfaces/srv/Json", "custom_interfaces/action/Json"])
// Interfaces by Kinex Python executable and type: a definition stays as its package was built.
const resolved = new Map<string, Interface>()

/** The interfaces of types that Kinex Python resolves (kinex.common.interfaces), and why others are missing.
 * Kinex Python is never prepared for them. */
async function interfaces(cwd: string, types: string[]) {
  const environment = await pythonEnvironment(cwd)
  if (!environment.present) return { found: new Map<string, Interface>(), problems: ["Kinex Python is not prepared"] }
  const key = (type: string) => `${environment.executable}\n${type}`
  const missing = types.filter(type => !resolved.has(key(type)))
  const failed = new Map<string, string[]>()  // the types each reason leaves without an interface
  const problems: string[] = []
  if (missing.length) try {
    const launch = await pythonLaunch(cwd, "node")
    const proc = spawnProcess([...launch.command, "-m", "kinex.common.interfaces"], { cwd, env: launch.env, signal: AbortSignal.timeout(60_000) })
    proc.stdin.write(JSON.stringify(missing))
    proc.stdin.end()
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (code !== 0) throw new Error(stderr.trim().split("\n").at(-1) || `exit code ${code}`)
    for (const [type, value] of Object.entries(JSON.parse(stdout) as Record<string, Interface | { error: string }>))
      if ("error" in value) failed.set(value.error, [...failed.get(value.error) ?? [], type])
      else resolved.set(key(type), value)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  problems.push(...[...failed].map(([reason, names]) => `${reason} (${names.join(", ")})`))
  return { found: new Map(types.flatMap(type => resolved.has(key(type)) ? [[type, resolved.get(key(type))!] as const] : [])), problems }
}

const fields = (value: Fields) => `{${Object.entries(value).map(([name, type]) => `${name}: ${type}`).join(", ")}}`

/** Every device of the workspace with its operations, their descriptions and, but for free-form ones, interfaces. */
export async function devicesContext(cwd: string) {
  // An invalid profile is the devices' problem to state, not the context's to fail on.
  const listed = await ProfileStore.listDevices(cwd).then(devices => ({ devices }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
  if ("error" in listed) return `devices unavailable: ${listed.error}`
  const { devices } = listed
  if (!devices.length) return ""
  const types = [...new Set(devices.flatMap(device => Object.values(device.operations).map(op => op.type)))].filter(type => !FREE.has(type))
  const { found, problems } = types.length ? await interfaces(cwd, types) : { found: new Map<string, Interface>(), problems: [] }
  const nested = new Map<string, Fields>()
  const lines = devices.flatMap(device => [`${device.name}: ${device.description}`, ...Object.entries(device.operations).flatMap(([name, op]) => {
    const parts = found.get(op.type)
    for (const [type, value] of Object.entries(parts?.types ?? {})) nested.set(type, value)
    return [`  ${name} (${op.transport} ${op.direction}, ${op.type}): ${op.description}`,
      ...parts ? [`    ${Object.entries(parts.interface).map(([part, value]) => `${part} ${fields(value)}`).join("; ")}`] : []]
  })])
  return ["<devices>", ...lines, ...nested.size ? ["types:", ...[...nested].map(([type, value]) => `  ${type} ${fields(value)}`)] : [],
    ...problems.length ? [`interfaces unavailable: ${problems.join("; ")}`] : [], "</devices>"].join("\n")
}
