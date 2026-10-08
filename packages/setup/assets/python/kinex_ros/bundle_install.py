"""Host preflight and dependency installation for bundles and template onboarding."""

import argparse
from contextlib import suppress
import json
import os
import re
import shutil
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


def _run(argv, cwd=None, timeout=600, env=None, stdout=subprocess.PIPE):
    proc, cancelled, previous = None, 0, {}
    def interrupt(signum, _frame):
        nonlocal cancelled
        cancelled = signum
        if proc is not None:
            raise SystemExit(128 + signum)
    try:
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            previous[signum] = signal.signal(signum, interrupt)
        # setpgrp works on Python 3.10 and keeps sudo in the authentication
        # session. Own a separate group so timeout cleanup cannot kill the host.
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stdout,
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


def preflight(bundle, facts, allow_sudo=False):
    """Needs entries for failed preflight checks (empty when everything passes)."""
    needs = [entry["need"] for entry in preflight_report(bundle, facts) if entry["status"] == "needs"]
    # Validate the host before installing anything. Explicit --install can
    # satisfy apt prerequisites, including checks outside pins.apt.
    if not allow_sudo or not needs or any(need["kind"] != "apt" for need in needs):
        return needs
    packages = list(dict.fromkeys(package for need in needs for package in need["packages"]))
    return _install_apt(packages, True) or preflight(bundle, facts)


def _sudo_authenticate():
    # Only sudo reads input. Connect it directly to the inherited user terminal;
    # passwords never pass through Python strings, subprocess pipes or JSON.
    import termios
    terminal = os.dup(sys.stdin.fileno())
    try:
        attributes = termios.tcgetattr(terminal)
        try:
            return subprocess.run(["sudo", "-S", "-p", "[Kinex] sudo password for %u: ", "-v"],
                                  stdin=terminal, stdout=terminal, stderr=terminal,
                                  timeout=300, check=False).returncode
        except subprocess.TimeoutExpired:
            return 124
        finally:
            termios.tcsetattr(terminal, termios.TCSANOW, attributes)
    finally:
        os.close(terminal)


def _sudo_need(packages, stage, code):
    helper = Path(__file__).resolve()
    command = (f"PYTHONHOME= PYTHONPATH={quote(str(helper.parents[1]))} {quote(sys.executable)} "
               f"-S {quote(str(helper))} --install --interactive -- " + " ".join(quote(p) for p in packages))
    return {**apt_need("apt", packages), "reason": "sudo_authentication", "stage": stage,
            "exit_code": code, "command": command,
            "text": "Sudo authentication is required. Run this command in an interactive terminal on this host; "
                    "enter the password only at sudo's terminal prompt, then resume onboarding."}


def _install_apt(packages, allow_sudo, interactive=False):
    packages = _apt_specs(packages)
    if not packages:
        return []
    if not sys.platform.startswith("linux") or not all(shutil.which(command) for command in ("apt-get", "dpkg", "dpkg-query")):
        return [{"kind": "platform", "id": "apt", "packages": packages,
                 "text": "apt dependencies require a Debian/Ubuntu Linux host with apt-get, dpkg and dpkg-query; run onboarding on the target host"}]
    missing = missing_apt(packages)
    if not missing:
        return []
    if not allow_sudo:
        return [apt_need("apt", missing)]
    # The host's shell permission covers this explicit invocation. Never read a
    # password from the model, change sudoers, or run a whole-system upgrade.
    prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
    # Sudo recognizes assignments separately from its permitted command.
    apt = prefix + (["DEBIAN_FRONTEND=noninteractive"] if prefix else []) + ["apt-get"]
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive", "LC_ALL": "C"}
    # Newer sudo discovers a terminal through standard descriptors even when
    # detached. Preserve the same tty ticket used by authentication: stream apt
    # progress to that terminal, while stdin stays closed and errors are captured.
    output = sys.stdin.fileno() if prefix and interactive and sys.stdin.isatty() else subprocess.PIPE
    for stage, args in (("update", ["update", "--error-on=any"]),
                        ("install", ["install", "-y", "--no-remove", "--", *missing])):
        for attempt in range(2):
            result = _run(apt + args, timeout=1800, env=env, stdout=output)
            if (prefix and "DEBIAN_FRONTEND=noninteractive" in apt and result.returncode == 1
                    and "not allowed to set the following environment variables: DEBIAN_FRONTEND" in result.stderr):
                # Sudo rejected the assignment before running apt. Retry within
                # the host's existing policy, without broader privileges.
                apt = prefix + ["apt-get"]
                result = _run(apt + args, timeout=1800, env=env, stdout=output)
            if not (prefix and result.returncode == 1 and "sudo: a password is required" in result.stderr):
                break
            if not interactive or not sys.stdin.isatty() or attempt:
                return [_sudo_need(missing, stage, result.returncode)]
            code = _sudo_authenticate()
            if code:
                need = _sudo_need(missing, "authenticate", code)
                need["text"] = "Sudo authentication failed or was cancelled; packages remain incomplete. " + need["text"]
                return [need]
        if result.returncode != 0:
            need = apt_need("apt", missing)
            need.update(stage=stage, exit_code=result.returncode,
                        text=f"apt {stage} failed: {_tail(result.stderr or result.stdout)}")
            return [need]
    remaining = missing_apt(missing)
    if not remaining:
        return []
    return [{**apt_need("apt", remaining), "stage": "verify", "text": "apt finished but required package versions are still missing: " + ", ".join(remaining)}]


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
    needs = _install_apt([render(package, facts) for package in pins["apt"]], allow_install)
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


def main(argv=None):
    """Standard-library-only apt entry point, usable before ROS or PyYAML exists."""
    parser = argparse.ArgumentParser(description="Check or install onboarding apt dependencies on this host.")
    parser.add_argument("--install", action="store_true", help="refresh apt indexes and install missing packages (root or sudo -n)")
    parser.add_argument("--interactive", action="store_true", help="allow sudo to authenticate directly on the user's terminal")
    parser.add_argument("packages", nargs="+", metavar="PACKAGE")
    args = parser.parse_args(argv)
    try:
        if args.interactive and not args.install:
            raise BundleError("--interactive requires --install")
        needs = _install_apt(args.packages, args.install, args.interactive)
        result = {"status": "needs" if needs else "ok", "needs": needs}
        code = 2 if needs else 0
    except BundleError as error:
        result, code = {"status": "error", "error": str(error)}, 1
    print(json.dumps(result), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
