#!/usr/bin/env python3
"""One concurrent sweep of several devices, as a single observation bundle."""

from kinex import args, devices, finish


def main():
    names = list(dict.fromkeys(args()["devices"]))
    bundle = {}
    for name, result in zip(names, devices([{"device": name} for name in names])):
        if not result.get("ok"):
            raise ValueError(f"observing {name} failed: {result.get('error', 'unknown error')}")
        entry = dict(result.get("data") or {})
        if result.get("file"):
            entry["file"] = result["file"]
        bundle[name] = entry
    finish({"devices": bundle})


main()
