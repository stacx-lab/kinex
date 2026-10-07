"""Controllable JSONL peer for wait cancellation and response-order tests."""

import json
import os
import sys
import threading
import time

with open("behavior.json") as source:
    behavior = json.load(source)
output = threading.Lock()
waiting = {}
interrupts = 0


def reply(request, **data):
    with output:
        print(json.dumps({"id": request["id"], "ok": True, **data}), flush=True)


def wait(request, cancel, finished):
    start = time.monotonic()
    interrupted = cancel.wait(request["args"]["duration_s"])
    time.sleep(behavior.get("reply_delay", 0) if interrupted else 0)
    reply(request, ok=not interrupted or behavior.get("late_success", False),
          error="wait cancelled", time_s=time.monotonic(), waited_s=time.monotonic() - start)
    waiting.pop(request["id"])
    finished.set()


def interrupt(request, target):
    if behavior.get("exit"):
        os._exit(1)
    if behavior.get("reject"):
        reply(request, ok=False, error="cancellation refused")
        return
    if target is not None and not behavior.get("missing_completion"):
        target[0].set()
    if behavior.get("missing_ack"):
        return
    if target is not None and behavior.get("reply_first"):
        target[1].wait()
    time.sleep(behavior.get("ack_delay", 0))
    reply(request)


for line in sys.stdin:
    request = json.loads(line)
    if "interrupt" in request:
        interrupts += 1
        threading.Thread(target=interrupt, args=(request, waiting.get(request["interrupt"])),
                         daemon=True).start()
    elif request["action"] == "wait":
        cancel, finished = threading.Event(), threading.Event()
        waiting[request["id"]] = (cancel, finished)
        threading.Thread(target=wait, args=(request, cancel, finished), daemon=True).start()
    elif request["action"] == "read" and behavior.get("hang_read"):
        continue
    else:
        reply(request, pid=os.getpid(), interrupts=interrupts, waiting=len(waiting),
              time_s=time.monotonic())
