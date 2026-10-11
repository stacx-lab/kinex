"""Host preflight and dependency installation for bundles and template onboarding."""

from contextlib import suppress
import os
import re
import signal
import subprocess
import sys
from pathlib import Path
from shlex import quote

from kinex_ros.bundle_manifest import BundleError, render
from kinex_ros.bundle_render import environment_lines

def skip_install():
    return os.environ.get("KINEX_BUNDLE_SKIP_INSTALL") == "1"


def _stop_process(proc):
    with suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGTERM)
    # Finish before the host's one-second SIGKILL escalation. A leader exiting
    # does not prove its workers exited, so always clean up the remaining group.
    with suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=.5)
    with suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGKILL)
    proc.wait()


def _run(argv, cwd=None, timeout=600, env=None):
    proc, cancelled, previous = None, 0, {}
    def interrupt(signum, _frame):
        nonlocal cancelled
        cancelled = signum
        if proc is not None:
            raise SystemExit(128 + signum)
    try:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[signum] = signal.signal(signum, interrupt)
        # Own a separate process group for timeout and cancellation cleanup.
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, preexec_fn=os.setpgrp)
        if cancelled:
            raise SystemExit(128 + cancelled)
        output, error = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(argv, proc.returncode, output or "", error or "")
    except FileNotFoundError:
        return subprocess.CompletedProcess(argv, 127, "", f"{argv[0]}: command not found")
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 124, "", f"{argv[0]}: timed out after {timeout}s")
    finally:
        try:
            if proc is not None:
                for signum in previous:
                    signal.signal(signum, signal.SIG_IGN)
                _stop_process(proc)
                for stream in (proc.stdout, proc.stderr):
                    if stream is not None:
                        stream.close()
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)


def _tail(text, lines=5):
    return "\n".join(text.strip().splitlines()[-lines:])


APT_PACKAGE = re.compile(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?(?:=[a-zA-Z0-9.+:~_-]+)?")


def _apt_specs(packages):
    for package in packages:
        # A trailing plus is valid in names such as g++; reject apt's removal suffix.
        if not APT_PACKAGE.fullmatch(package) or package.partition("=")[0].partition(":")[0].endswith("-"):
            raise BundleError(f"invalid apt package {package!r}; expected name[:arch][=version]")
    return list(dict.fromkeys(packages))


def missing_apt(packages):
    packages = _apt_specs(packages)
    if not packages:
        return []
    native_arch = _run(["dpkg", "--print-architecture"]).stdout.strip()
    missing = []
    for package in packages:
        name, _, version = package.partition("=")
        name, _, arch = name.partition(":")
        arch = arch or native_arch
        result = _run(["dpkg-query", "-W", "-f=${db:Status-Status}\t${db:Status-Eflag}\t${Version}\t${Architecture}\n", "--", name])
        # Unqualified queries can return multiple architectures, including 'all'.
        records = [line.split("\t") for line in result.stdout.splitlines()]
        if result.returncode != 0 or not any(
                len(fields) == 4 and fields[:2] == ["installed", "ok"]
                and fields[3] in (arch, "all") and (not version or fields[2] == version)
                for fields in records):
            missing.append(package)
    return missing


def apt_need(identifier, packages):
    return {"kind": "apt", "id": identifier, "packages": packages, "command": "sudo apt-get install -y --no-remove " + " ".join(quote(p) for p in packages),
            "text": "missing system packages: " + ", ".join(packages)}


def env_file_names(directory):
    """Names exported by ``<dir>/env.sh``; values are never read."""
    path = Path(directory) / "env.sh"
    if not path.is_file():
        return set()
    return set(re.findall(r"^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=", path.read_text(), re.MULTILINE))


def _apt_packages(bundle, item, facts):
    packages = bundle.manifest["pins"]["apt"] if item["packages"] == "pins.apt" else item["packages"]
    return [render(package, facts) for package in packages]


def _check_item(bundle, item, facts):
    kind = item["kind"]
    identifier = item["id"]
    if kind == "platform":
        if sys.platform.startswith(item["value"]):
            return None
        return {"kind": "platform", "id": identifier, "text": f"requires {item['value']} (running on {sys.platform}); run Kinex on a host that can reach the hardware"}
    if kind == "file":
        path = render(item["path"], facts)
        if Path(path).exists():
            return None
        return {"kind": "file", "id": identifier, "text": f"{path} does not exist"}
    if kind == "python":
        minimum = tuple(int(part) for part in item["min"].split("."))
        if sys.version_info[:len(minimum)] >= minimum:
            return None
        return {"kind": "python", "id": identifier, "text": f"python >= {item['min']} required, found {sys.version.split()[0]}"}
    if kind == "command":
        argv = [render(entry, facts) for entry in item["argv"]]
        result = _run(argv, timeout=60)
        if result.returncode == 0:
            return None
        return {"kind": "command", "id": identifier, "command": " ".join(argv),
                "text": f"{' '.join(argv)} exited {result.returncode}: {_tail(result.stderr or result.stdout)}".strip()}
    if kind == "apt":
        missing = missing_apt(_apt_packages(bundle, item, facts))
        return apt_need(identifier, missing) if missing else None
    if kind == "env_file":
        names = bundle.manifest["secrets"] if item["names"] == "secrets" else item["names"]
        missing = [name for name in names if name not in env_file_names(bundle.device_directory)]
        if not missing:
            return None
        return {"kind": "env", "id": identifier, "names": missing,
                "text": f"create {bundle.device_directory / 'env.sh'} (chmod 600) exporting {', '.join(missing)}; Kinex never reads or prints it"}
    interface = render(item["interface"], facts)
    if _run(["ip", "link", "show", interface]).returncode == 0:
        return None
    bitrate = render(str(item["bitrate"]), facts) if item["bitrate"] is not None else "1000000"
    return {"kind": "can", "id": identifier, "command": f"sudo ip link set {interface} up type can bitrate {bitrate}",
            "text": f"CAN interface {interface} is not present; connect the adapter on this host"}


def preflight_report(bundle, facts):
    """Per-check results: ``{id, kind, status: ok|skipped|needs, need?}``."""
    skipped_kinds = ("platform", "command", "apt", "can") if skip_install() else ()
    report = []
    for item in bundle.manifest["preflight"]:
        entry = {"id": item["id"], "kind": item["kind"], "status": "ok"}
        if item["kind"] in skipped_kinds or (item["skip_when"] is not None and facts.get(item["skip_when"])):
            entry["status"] = "skipped"
        else:
            need = _check_item(bundle, item, facts)
            if need is not None:
                entry.update(status="needs", need=need)
        report.append(entry)
    return report


def preflight(bundle, facts):
    """Report failed prerequisites without installing system packages."""
    return [entry["need"] for entry in preflight_report(bundle, facts) if entry["status"] == "needs"]


def _install_pip(bundle, pins):
    if not pins:
        return []
    argv = [bundle.manifest["ros"]["python"], "-m", "pip", "install", "--user"] + pins
    result = _run(argv, timeout=1800)
    if result.returncode == 0:
        return []
    return [{"kind": "pip", "id": "pip", "command": " ".join(argv), "text": f"pip install failed: {_tail(result.stderr or result.stdout)}"}]


def _git_name(url):
    name = url.rstrip("/").rsplit("/", 1)[-1]
    return name[:-4] if name.endswith(".git") else name


def _checkout_git(bundle, facts, pin):
    url, rev = render(pin["url"], facts), render(pin["rev"], facts)
    destination = bundle.device_directory / "src" / _git_name(url)
    steps = []
    if (destination / ".git").exists():
        origin = _run(["git", "-C", str(destination), "config", "--get", "remote.origin.url"])
        if origin.returncode != 0 or origin.stdout.strip() != url:
            return [{"kind": "git", "id": f"git:{_git_name(url)}", "reason": "source_mismatch",
                     "text": f"Existing checkout {destination} does not match the declared Git origin; resolve the source collision before retrying."}]
    else:
        steps.append(["git", "clone", "--no-checkout", url, str(destination)])
    steps += [["git", "-C", str(destination), "fetch", "--depth", "1", "origin", rev],
              ["git", "-C", str(destination), "checkout", "--detach", "FETCH_HEAD"]]
    for argv in steps:
        result = _run(argv, timeout=1800)
        if result.returncode != 0:
            return [{"kind": "git", "id": f"git:{_git_name(url)}", "command": " ".join(argv), "text": f"git failed: {_tail(result.stderr)}"}]
    return []


def _build_colcon(bundle, facts):
    sources = [bundle.device_directory / "src" / _git_name(render(pin["url"], facts))
               for pin in bundle.manifest["pins"]["git"] if pin["build"] == "colcon"]
    if not sources:
        return []
    workspace = bundle.device_directory / "ws"
    workspace.mkdir(parents=True, exist_ok=True)
    command = (f"colcon build --base-paths {' '.join(quote(str(source)) for source in sources)} "
               f"--build-base {quote(str(workspace / 'build'))} --install-base {quote(str(workspace / 'install'))}")
    script = "\n".join(["set -eo pipefail", f"HERE={quote(str(bundle.directory.resolve()))}", f"DEVICE={quote(str(bundle.device_directory.resolve()))}"] +
                      environment_lines(bundle, facts, workspace=False) + [command])
    result = _run(["bash", "-c", script], cwd=str(workspace), timeout=3600)
    if result.returncode == 0:
        return []
    return [{"kind": "build", "id": "colcon", "command": f"cd {quote(str(workspace))} && bash -c {quote(script)}",
             "text": f"colcon build failed: {_tail(result.stderr or result.stdout)}"}]


def install(bundle, facts, allow_install=False):
    """Check apt pins; prepare dependencies only with explicit installation enabled."""
    if skip_install():
        return []
    pins = bundle.manifest["pins"]
    missing = missing_apt([render(package, facts) for package in pins["apt"]])
    needs = [apt_need("apt", missing)] if missing else []
    pip = [render(pin, facts) for pin in pins["pip"]]
    if not allow_install:
        if pip:
            needs.append({"kind": "pip", "id": "pip", "packages": pip,
                          "text": "Rerun provisioning with --install to prepare the declared Python packages."})
        for pin in pins["git"]:
            url, rev = render(pin["url"], facts), render(pin["rev"], facts)
            needs.append({"kind": "git", "id": f"git:{_git_name(url)}", "url": url, "rev": rev,
                          "text": "Rerun provisioning with --install to prepare the declared Git source and build."})
        return needs
    if needs:
        return needs
    needs += _install_pip(bundle, pip)
    for pin in pins["git"]:
        needs += _checkout_git(bundle, facts, pin)
    # Discover all packages together so colcon can order cross-repository dependencies.
    return needs or _build_colcon(bundle, facts)
