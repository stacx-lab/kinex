import { execFile } from "node:child_process"
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Global } from "@kinex/core/global"
import { pythonDir } from "./layout.ts"

// A worker runs in a bubblewrap sandbox built from an empty root. It sees only
// what is bound here: the system, Node, Kinex, the shared Python environment, its
// configuration and credentials, its workspace and its transcript. Everything
// else on the host has no name inside: rosbridge's command, files and processes,
// other trials, the run's libraries and the verdicts. It shares the host's
// network, which DDS to its simulator and the model's API need.

const exec = promisify(execFile)

// The system folders as the host has them: on merged-/usr hosts /bin and /lib are links into /usr.
function system(): string[] {
  const args = ["--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc"]
  for (const name of ["bin", "sbin", "lib", "lib64", "lib32", "libx32"]) {
    const entry = path.join("/", name)
    const stat = lstatSync(entry, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink()) args.push("--symlink", readlinkSync(entry), entry)
    else if (stat?.isDirectory()) args.push("--ro-bind", entry, entry)
  }
  // systemd-resolved keeps the resolver file outside /etc.
  const resolver = existsSync("/etc/resolv.conf") ? path.dirname(realpathSync("/etc/resolv.conf")) : "/etc"
  if (resolver !== "/etc" && !resolver.startsWith("/etc/")) args.push("--ro-bind", resolver, resolver)
  return args
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

/** `argv` run inside the sandbox, with the Node and Kinex this process runs on. */
export function sandboxed(argv: readonly string[], workspace: string, session: string): string[] {
  const [node, entry] = [process.execPath, process.argv[1]]
  if (!entry) throw new Error("Cannot locate the running Kinex entry point")
  const config = Global.Path.config
  const agent = path.join(config, "agent")
  const settings = path.join(agent, "settings.json")
  // Standalone keeps the credentials in its data folder behind a link from the agent folder;
  // they are refreshed in place, with a lock beside the link.
  const auth = existsSync(path.join(agent, "auth.json")) ? realpathSync(path.join(agent, "auth.json")) : undefined
  const readOnly = [path.dirname(path.dirname(realpathSync(node))), kinexRoot(entry), pythonDir(), config].filter(existsSync)
  return ["bwrap", "--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    ...system(),
    // Mounted before the binds, which may lie below them (Node under the home folder, a test run under /tmp).
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", os.homedir(),
    ...readOnly.flatMap(directory => ["--ro-bind", directory, directory]),
    ...(existsSync(agent) ? ["--bind", agent, agent] : []),
    ...(existsSync(settings) ? ["--ro-bind", settings, settings] : []),
    ...(auth && !auth.startsWith(agent + path.sep) ? ["--bind", auth, auth] : []),
    "--bind", workspace, workspace, "--bind", session, session, "--chdir", workspace,
    // /dev/shm is the sandbox's own, so DDS reaches the simulator over UDP rather than shared memory.
    "--setenv", "FASTDDS_BUILTIN_TRANSPORTS", "UDPv4",
    "--", ...argv]
}

// Checked once per process, before a trial launches a simulator for a worker that could not start.
let ready: Promise<void> | undefined
export function sandboxReady(): Promise<void> {
  ready ??= exec("bwrap", ["--unshare-all", "--share-net", "--ro-bind", "/", "/", "true"]).then(() => {}, (error: Error & { stderr?: string }) => {
    ready = undefined
    throw new Error(`This run sandboxes its workers with bubblewrap, which cannot run here: ${error.stderr?.trim() || error.message}. ` +
      `Install bubblewrap and allow unprivileged user namespaces, or set "sandbox": false in the run's config.json.`)
  })
  return ready
}
