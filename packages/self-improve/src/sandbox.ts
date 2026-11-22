import { execFile } from "node:child_process"
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Global } from "@kinex/core/global"
import { agentsDir } from "./agents.ts"
import { kinex } from "./kinex.ts"
import { pythonDir, runsDir } from "./layout.ts"

// A worker runs in a sandbox built from an empty root: bubblewrap's, or where
// that cannot run a Docker container's. It sees only what is bound here: the
// system, Node, Kinex, the shared Python environment, its configuration and
// credentials, its workspace and its transcript. Everything else on the host
// has no name inside: rosbridge's command, files and processes, other trials,
// the run's libraries and the verdicts. It shares the host's network, which DDS
// to its simulator and the model's API need.
export type Sandbox = "bwrap" | "docker"

const exec = promisify(execFile)

// The system folders as the host has them: on merged-/usr hosts /bin and /lib are
// links into /usr, which bubblewrap's empty root is given and a container's image has.
function system(): { folders: string[]; links: [target: string, link: string][] } {
  const folders = ["/usr", "/etc"]
  const links: [string, string][] = []
  for (const name of ["bin", "sbin", "lib", "lib64", "lib32", "libx32"]) {
    const entry = path.join("/", name)
    const stat = lstatSync(entry, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) links.push([readlinkSync(entry), entry])
    else if (stat?.isDirectory()) folders.push(entry)
  }
  // systemd-resolved keeps the resolver file outside /etc.
  const resolver = existsSync("/etc/resolv.conf") ? path.dirname(realpathSync("/etc/resolv.conf")) : "/etc"
  if (resolver !== "/etc" && !resolver.startsWith("/etc/")) folders.push(resolver)
  return { folders, links }
}

// Installed Kinex lives at <prefix>/node_modules/kinex with its dependencies beside
// it; a checkout keeps them in its own node_modules.
function kinexRoot(entry: string): string {
  const real = realpathSync(entry)
  const installed = real.indexOf(`${path.sep}node_modules${path.sep}`)
  if (installed > 0) return real.slice(0, installed)
  for (let directory = path.dirname(real); directory !== path.dirname(directory); directory = path.dirname(directory))
    if (existsSync(path.join(directory, "package.json"))) return directory
  throw new Error(`Cannot find the Kinex installation of ${entry}`)
}

// What a worker may see of the host beyond the system, and what of it it may write.
function binds() {
  const [node, entry] = [process.execPath, kinex.entry]
  if (!entry) throw new Error("Cannot locate the running Kinex entry point")
  const config = Global.Path.config
  const agent = path.join(config, "agent")
  const settings = path.join(agent, "settings.json")
  // Standalone keeps the credentials in its data folder behind a link from the agent folder;
  // they are refreshed in place, with a lock beside the link.
  const auth = existsSync(path.join(agent, "auth.json")) ? realpathSync(path.join(agent, "auth.json")) : undefined
  return {
    readOnly: [path.dirname(path.dirname(realpathSync(node))), kinexRoot(entry), pythonDir(), config].filter(existsSync),
    // In this order: the agent folder is writable, and inside it the settings and
    // the commands a run's jobs are started with, which the scheduling Kinex reads, are not.
    inAgent: [...(existsSync(agent) ? [{ path: agent, write: true }] : []), ...[settings, agentsDir()].filter(existsSync).map(target => ({ path: target, write: false })),
      ...(auth && !auth.startsWith(agent + path.sep) ? [{ path: auth, write: true }] : [])],
  }
}

interface Options { name?: string; image?: string; env?: NodeJS.ProcessEnv }

// `argv` in the sandbox, which may write `write` and starts in `directory`.
function within(kind: Sandbox, argv: readonly string[], write: readonly string[], directory: string, options: Options): string[] {
  const { folders, links } = system()
  const { readOnly, inAgent } = binds()
  if (kind === "docker") {
    const mount = (target: string, readonly: boolean) => ["--mount", `type=bind,source=${target},target=${target}${readonly ? ",readonly" : ""}`]
    const user = os.userInfo()
    // No --init: Docker puts its init at /sbin, which here is the host's. A container that
    // outlives its command, because its first process ignores a signal, is removed by name.
    return ["docker", "run", "--rm", ...(options.name ? ["--name", options.name] : []),
      "--network", "host", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", `${user.uid}:${user.gid}`,
      // Kinex keeps a session folder in its data folder, which a container, unlike bubblewrap's root, would not let it make.
      "--tmpfs", "/tmp:exec,mode=1777", "--tmpfs", `${os.homedir()}:exec,mode=1777`, "--tmpfs", `${path.join(path.dirname(runsDir()), "agent")}:exec,mode=1777`,
      ...folders.flatMap(folder => mount(folder, true)), ...readOnly.flatMap(target => mount(target, true)),
      ...inAgent.flatMap(entry => mount(entry.path, !entry.write)), ...write.flatMap(target => mount(target, false)),
      "--workdir", directory,
      // A container starts with the image's environment, so the worker's own is named variable by variable.
      ...Object.keys(options.env ?? {}).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).flatMap(name => ["--env", name]),
      // /dev/shm is the sandbox's own, so DDS reaches the simulator over UDP rather than shared memory.
      "--env", "FASTDDS_BUILTIN_TRANSPORTS=UDPv4",
      options.image ?? IMAGE, ...argv]
  }
  return ["bwrap", "--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    ...folders.flatMap(folder => ["--ro-bind", folder, folder]), ...links.flatMap(([target, link]) => ["--symlink", target, link]),
    // Mounted before the binds, which may lie below them (Node under the home folder, a test run under /tmp).
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", os.homedir(),
    ...readOnly.flatMap(target => ["--ro-bind", target, target]),
    ...inAgent.flatMap(entry => [entry.write ? "--bind" : "--ro-bind", entry.path, entry.path]),
    ...write.flatMap(target => ["--bind", target, target]), "--chdir", directory,
    // /dev/shm is the sandbox's own, so DDS reaches the simulator over UDP rather than shared memory.
    "--setenv", "FASTDDS_BUILTIN_TRANSPORTS", "UDPv4",
    "--", ...argv]
}

/** `argv` run inside the sandbox, with the Node and Kinex this process runs on. */
export function sandboxed(argv: readonly string[], workspace: string, session: string, kind: Sandbox = "bwrap", options: Options = {}): string[] {
  return within(kind, argv, [workspace, session], workspace, options)
}

// A container's root is its image's, under the host's system folders bound over it:
// any image with the host's /bin and /lib links serves.
export const IMAGE = "ubuntu:24.04"

const NAMES: Record<Sandbox, string> = { bwrap: "bubblewrap", docker: "Docker" }
// Whether a worker could start in the sandbox is found by starting nothing in it, with all a worker
// is given: a Docker that cannot bind a folder, as on a home it may not read, is not one that can run here.
// Checked once per process, before a trial launches a simulator for a worker that could not start.
const checked = new Map<string, Promise<string | undefined>>()
function unavailable(kind: Sandbox, image?: string): Promise<string | undefined> {
  const key = `${kind} ${image ?? ""}`
  const found = checked.get(key) ?? Promise.resolve().then(() => within(kind, ["true"], [], "/", { image })).then(([file = kind, ...args]) => exec(file, args))
    .then(() => undefined, (error: Error & { stderr?: string }) => error.stderr?.trim().split("\n")[0] || error.message)
  checked.set(key, found)
  return found
}

/**
 * The sandbox a run's workers use: the one its configuration names, or with
 * `true` bubblewrap where it can run and Docker where it cannot. A run that asks
 * for a sandbox this host cannot give does not start its workers without one.
 */
export async function sandboxOf(wanted: boolean | Sandbox | undefined, image?: string): Promise<Sandbox | undefined> {
  if (!wanted) return undefined
  const reasons: string[] = []
  for (const kind of wanted === true ? ["bwrap", "docker"] as const : [wanted]) {
    const reason = await unavailable(kind, image)
    if (!reason) return kind
    reasons.push(`${NAMES[kind]}: ${reason}`)
  }
  throw new Error(`This run sandboxes its workers, and no sandbox can run here (${reasons.join("; ")}). ` +
    `Install bubblewrap and allow unprivileged user namespaces, or give this user a Docker that can bind Node, Kinex and Kinex's folders, or start the run with KINEX_SELF_IMPROVE_SANDBOX=off.`)
}

/** What a new run's workers are sandboxed with here, by name, or undefined when it runs them without. */
export async function sandboxName(): Promise<string | undefined> {
  const kind = await sandboxOf(sandboxSetting())
  return kind && NAMES[kind]
}

/** A new run's sandbox: on unless KINEX_SELF_IMPROVE_SANDBOX says off, or names the one to use. */
export function sandboxSetting(): boolean | Sandbox {
  const value = process.env.KINEX_SELF_IMPROVE_SANDBOX
  return value === "off" ? false : value === "bwrap" || value === "docker" ? value : true
}

/** Removes the container `name`, which outlives a Docker command that was killed. */
export const removeContainer = (name: string) => exec("docker", ["rm", "--force", name]).then(() => {}, () => {})
