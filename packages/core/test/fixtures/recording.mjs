import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import path from 'node:path'

// Control-channel stand-in only. Native ROS tests verify capture and world time.
export async function recordingDevices(runtime, directory) {
  const real = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {encoding:'utf8'}).trim()
  const interpreter = path.join(directory, 'recording-runtime')
  await writeFile(interpreter, `#!${real}
import json, pathlib, sys
capture = sys.argv[-1] == 'kinex.ros_recording'
count = 0
for line in sys.stdin:
    request = json.loads(line)
    if capture:
        count += 1
        if 'catalog' in request:
            directory = pathlib.Path(request['dir'])
            directory.mkdir(parents=True, exist_ok=True)
            (directory / 'samples.jsonl').write_text('')
            result = {'ready': True, 'status': 'recording'}
        elif request['action'] == 'stop':
            result = {'done': True, 'status': 'stopped'}
        else:
            result = {'status': 'recording'}
        result.update(capture_samples=count, samples=count, bag=str(directory / 'bag'))
    else:
        result = {'id': request['id'], 'ok': True, 'data': {'ready': True}}
    print(json.dumps(result), flush=True)
    if capture and result.get('done'): break
`)
  await chmod(interpreter, 0o755)
  // Recording must use Kinex Python even when device nodes use another interpreter.
  const python = (await runtime.python.status()).executable
  await mkdir(path.dirname(python), {recursive:true})
  await rm(python, {force:true})
  await writeFile(python, `#!${real}
import os, sys
executable = ${JSON.stringify(interpreter)} if sys.argv[-1] == 'kinex.ros_recording' else ${JSON.stringify(real)}
os.execv(executable, [executable, *sys.argv[1:]])
`, {mode:0o755})
  for (const [name, type, operations] of [
    ['record_clock', 'world', { time: { type: 'rosgraph_msgs/msg/Clock', endpoint: '/clock' } }],
    ['telemetry', 'other', { temperature: { type: 'std_msgs/msg/Float64', endpoint: '/temperature' },
      status: { type: 'std_msgs/msg/String', endpoint: '/health' } }],
  ]) {
    // status is a host verb; use a different public operation name.
    if (operations.status) { operations.health = operations.status; delete operations.status }
    await runtime.profiles.writeDevice({ name, type, loaded: false, runtime: { interpreter },
      operations: Object.fromEntries(Object.entries(operations).map(([key, op]) => [key,
        { ...op, description: key, transport: 'topic', direction: 'output' }])) })
    await (await runtime.devices.load(name)).ready
  }
}
