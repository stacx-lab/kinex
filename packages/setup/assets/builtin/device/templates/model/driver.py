#!/usr/bin/env python3
"""Model service skeleton. Fill the SDK hooks using the sibling profile."""

import contextlib
import pathlib
import sys

import yaml
from kinex.driver_protocol import run

HERE = pathlib.Path(__file__).resolve().parent
SERVICE = None


def profile():
    return yaml.safe_load((HERE / "profile.yaml").read_text())


def open_service(config):
    """Start owned services/load artifacts or open a remote client; wait for readiness.

    Undo partially acquired resources if initialization fails.
    """
    raise NotImplementedError("implement the model SDK/client connection")


def infer(service, operation, args):
    """Return exactly the declared operation.output payload."""
    raise NotImplementedError("implement the declared inference operations")


def close_service(service):
    """Release owned services/resources or close a borrowed client, never its server."""
    raise NotImplementedError("implement resource cleanup")


def handle(action, args):
    global SERVICE
    if action in ("read", "status"):
        return {"loaded": SERVICE is not None}
    if action == "unload":
        service, SERVICE = SERVICE, None
        if service is not None:
            close_service(service)
        return {"loaded": False}
    config = profile()
    names = [operation["name"] for operation in config["intrinsics"].get("operations", [])]
    if config["type"] in {"detection", "segmentation"}:
        names.append("detect")
    if action != "load" and action not in names:
        raise ValueError(f"undeclared model operation: {action}")
    if SERVICE is None:
        SERVICE = open_service(config)
        if SERVICE is None:
            raise RuntimeError("open_service must return the initialized model/client")
    if action == "load":
        return {"loaded": True}
    return infer(SERVICE, action, args)


def respond(action, args):
    try:
        # SDK diagnostics must never corrupt the JSON-lines response stream.
        with contextlib.redirect_stdout(sys.stderr):
            result = handle(action, args)
        return {"ok": True, **result}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def main():
    run(respond, lambda: handle("unload", {}))


if __name__ == "__main__":
    main()
