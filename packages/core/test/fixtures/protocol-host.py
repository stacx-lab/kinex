"""Test-only stand-in for the ROS host control channel; no production fallback."""
import concurrent.futures
import json
import os
from pathlib import Path
import sys
import threading
import time

lock = threading.Lock()
profile = None
calls = 0
stopped = False
event_log = open("events.jsonl", "a")
requests = {}
namespace = {}
handler = Path('handler.py')
if handler.exists():
    exec(compile(handler.read_text(), str(handler), 'exec'), namespace)

def emit(value):
    with lock:
        print(json.dumps(value), flush=True)

def run(request):
    global profile, calls, stopped
    action, args = request['action'], request.get('args', {})
    event = requests[request['id']]
    try:
        with lock:
            calls += 1
            count = calls
            event_log.write(json.dumps(request) + '\n')
            event_log.flush()
        if action == 'stop':
            stopped = True
        if action == 'load':
            profile = args['profile']
        if 'dispatch' in namespace:
            result = namespace['dispatch'](action, args, request.get('owner'), event)
        else:
            if event.wait(args.get('sleep', 0)):
                raise InterruptedError('cancelled')
            if args.get('noisy'):
                os.write(2, b'x' * 1024 * 1024)
            result = {'ready': True, 'faults': [], 'stopped': stopped, 'value': 1, 'pid': os.getpid(), 'calls': count, **args}
        emit({'id': request['id'], 'ok': True, 'data': result})
    except Exception as error:
        emit({'id': request['id'], 'ok': False, 'error': str(error)})
    finally:
        requests.pop(request['id'], None)

with concurrent.futures.ThreadPoolExecutor() as pool:
    for line in sys.stdin:
        request = json.loads(line)
        if 'cancel' in request:
            event = requests.get(request['cancel'])
            if event:
                event.set()
            continue
        requests[request['id']] = threading.Event()
        pool.submit(run, request)
    for event in list(requests.values()):
        event.set()
if Path('.').exists():
    try:
        Path('closed').write_text(str(os.getpid()))
    except FileNotFoundError:
        pass
event_log.close()
