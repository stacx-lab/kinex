import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createKinexRuntime } from '../dist/index.js'
import { urdfModel } from '../dist/device/joint-model.js'

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-joint-model-'))
  const assetsRoot = path.join(directory, 'assets')
  const runtime = createKinexRuntime({ directory, assetsRoot })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const python = await runtime.python.initialize()
  await mkdir(path.dirname(python.executable), { recursive: true })
  const executable = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  await symlink(executable, python.executable)
  const started = path.join(directory, 'started')
  const release = path.join(directory, 'release')
  const parser = fileURLToPath(new URL('../assets/python/introspect_urdf.py', import.meta.url))
  await mkdir(path.join(assetsRoot, 'python'), { recursive: true })
  await writeFile(path.join(assetsRoot, 'python/introspect_urdf.py'), `import os, pathlib, runpy, sys, time
sys.path.insert(0, ${JSON.stringify(path.dirname(parser))})
with open(${JSON.stringify(started)}, 'a') as output: output.write(str(os.getpid()) + '\\n')
while not pathlib.Path(${JSON.stringify(release)}).exists(): time.sleep(.005)
runpy.run_path(${JSON.stringify(parser)}, run_name='__main__')
`)
  const file = path.join(directory, 'arm.urdf')
  await writeFile(file, '<robot name="arm"><link name="base"/><link name="tip"/><joint name="j" type="revolute"><parent link="base"/><child link="tip"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="10" velocity="1"/></joint></robot>')
  return {
    runtime,
    parse: signal => runtime.operation(() => urdfModel(directory, file, 'base', 'tip'), signal),
    release: () => writeFile(release, ''),
    async started() {
      for (let i = 0; i < 200; i++) {
        const content = await readFile(started, 'utf8').catch(error => {
          if (error.code !== 'ENOENT') throw error
          return ''
        })
        if (content) return content.trim().split('\n').map(Number)
        await delay(10)
      }
      throw new Error('URDF parser did not start')
    },
  }
}

for (const index of [0, 1]) test(`cancelling URDF caller ${index + 1} preserves shared parsing and cache`, { timeout: 10000 }, async t => {
  const model = await fixture(t)
  const controllers = [new AbortController(), new AbortController()]
  const first = model.parse(controllers[0].signal)
  const outcomes = [first.then(value => ({ value }), error => ({ error }))]
  await model.started()
  outcomes.push(model.parse(controllers[1].signal).then(value => ({ value }), error => ({ error })))
  await delay(50)
  controllers[index].abort(new Error('cancel this caller'))
  const cancelled = await Promise.race([outcomes[index], delay(500).then(() => ({ error: new Error('cancellation timed out') }))])
  assert.equal(cancelled.error?.message, 'cancel this caller')
  await model.release()
  const remaining = await outcomes[1 - index]
  assert.equal(remaining.error, undefined)
  assert.equal(remaining.value.joints[0].name, 'j')
  assert.deepEqual(await model.parse(), remaining.value)
  assert.equal((await model.started()).length, 1, 'reuse the original parser and its cached result')
})

test('runtime disposal cancels shared URDF parsing and releases its process', { timeout: 10000 }, async t => {
  const model = await fixture(t)
  const first = assert.rejects(model.parse())
  const [pid] = await model.started()
  const second = assert.rejects(model.parse())
  await model.runtime.dispose()
  await Promise.all([first, second])
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
