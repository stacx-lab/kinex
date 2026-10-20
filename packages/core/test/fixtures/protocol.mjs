import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const outputOperation = (name = 'read') => ({ description: '', transport: 'topic', direction: 'output', endpoint: `/test/${name}`, type: 'std_msgs/msg/Float64' })
export const inputOperation = (name = 'write') => ({ description: '', transport: 'service', direction: 'input', endpoint: `/test/${name}`, type: 'std_srvs/srv/Trigger' })

export async function protocolDevice(runtime, directory, name = 'sensor', { handler, operations, loaded = false, ...profile } = {}) {
  const dir = path.join(directory, '.kinex/devices', name)
  await mkdir(dir, { recursive: true })
  const real = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  const host = path.join(dir, 'test-host.py')
  await copyFile(fileURLToPath(new URL('./protocol-host.py', import.meta.url)), host)
  const interpreter = path.join(dir, 'test-python')
  await writeFile(interpreter, `#!${real}\nimport os, sys\nos.execv(${JSON.stringify(real)}, [${JSON.stringify(real)}, '-u', ${JSON.stringify(host)}])\n`, { mode: 0o755 })
  if (handler) await writeFile(path.join(dir, 'handler.py'), handler)
  await runtime.profiles.writeDevice({ name, type: 'other', description: '', loaded: false, ...profile,
    runtime: { interpreter }, operations: operations ?? { read: outputOperation(), write: inputOperation(), stop: inputOperation('stop') } })
  if (loaded) await (await runtime.devices.load(name)).ready
  return dir
}

export async function protocolCamera(runtime, directory, name = 'camera') {
  const file = path.join(directory, `${name}.png`)
  await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
  await protocolDevice(runtime, directory, name, {type:'rgb',loaded:true,handler:`def dispatch(action, args, owner, cancelled):\n    return {'file': ${JSON.stringify(file)}, 'timestamp': 1} if action in ('read', '$sample') else {'ready':True}\n`})
  return file
}
