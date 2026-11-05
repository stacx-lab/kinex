import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKinexRuntime } from '../dist/index.js'
import { Device } from '../dist/device/profile/schema.js'
import { protocolDevice, outputOperation } from './fixtures/protocol.mjs'
import { useUv } from './fixtures/python.mjs'

const color = (width, height) => ({ width, height, fps: 30,
  projection: { model: 'pinhole', fx: 100, fy: 100, cx: 1, cy: 1, skew: 0 }, distortion: { model: 'opencv_fisheye', coefficients: [0, 0, 0, 0] } })
const frame = (x, parent = 'pair:base') => ({ parent, translation_m: [x, 0, 0], rotation_xyzw: [0, 0, 0, 1] })
const stereo = { name: 'pair', description: '', type: 'rgb', loaded: false, meta: { created_at: '', updated_at: '' },
  left: color(4, 3), right: color(6, 5),
  frames: { base: { parent: null, translation_m: null, rotation_xyzw: null }, left: frame(0), right: frame(.1, 'pair:left') } }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')

test('an rgb camera is mono by default; stereo needs both eyes, both frames and no color', () => {
  const parsed = Device.parse(stereo)
  assert.equal(parsed.right.width, 6)
  assert.equal(Device.parse({ ...stereo, left: undefined, right: undefined }).color, '???')
  assert.equal(Device.safeParse({ ...stereo, right: undefined }).success, false)
  assert.equal(Device.safeParse({ ...stereo, color: color(4, 3) }).success, false)
  assert.equal(Device.safeParse({ ...stereo, frames: { base: stereo.frames.base, left: stereo.frames.left } }).success, false)
  assert.equal(Device.safeParse({ ...stereo, left: '???', right: '???' }).success, true)
  const frames = (left, right) => ({ ...stereo, frames: { ...stereo.frames, left, right } })
  assert.equal(Device.safeParse(frames(frame(.1, 'pair:right'), frame(0))).success, true)
  assert.equal(Device.safeParse(frames(frame(0), frame(.1))).success, false)
  assert.equal(Device.safeParse(frames(frame(0, 'arm:flange'), frame(.1, 'pair:left'))).success, false)
})

test('stereo readiness requires each eye and its measured frame', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-stereo-'))
  const runtime = createKinexRuntime({ directory })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'robot', name: 'Robot', kind: 'arm' } })
  const { meta, ...profile } = stereo
  const item = async () => (await runtime.readiness()).items.find(entry => entry.id === 'profile:pair')
  await runtime.profiles.writeDevice({ ...profile, loaded: true, left: '???' })
  assert.match((await item()).detail, /left is incomplete/)
  await runtime.profiles.writeDevice({ name: 'pair', left: color(4, 3), frames: { left: { ...frame(0), translation_m: '???' } } })
  assert.match((await item()).detail, /frames\.left transform is unknown/)
  await runtime.profiles.writeDevice({ name: 'pair', frames: { left: frame(0) } })
  assert.match((await item()).detail, /stereo left and right/)
})

test('stereo snapshots record both eyes without a primary file', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinex-stereo-'))
  await useUv(path.join(directory, '.kinex'))
  const runtime = createKinexRuntime({ directory, host: { ask: async () => {} } })
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.profiles.writeManifest({ identity: { id: 'robot', name: 'Robot', kind: 'arm' } })
  const [left, right] = ['left.png', 'right.png'].map(name => path.join(directory, name))
  await writeFile(left, PNG)
  await writeFile(right, PNG)
  const { meta, name, ...profile } = stereo
  await protocolDevice(runtime, directory, name, { ...profile, loaded: true,
    operations: { left_image: outputOperation('left'), right_image: outputOperation('right') },
    handler: `def dispatch(action, args, cancelled):\n    return {'left_file': ${JSON.stringify(left)}, 'right_file': ${JSON.stringify(right)}, 'timestamp': 1}\n` })
  const { dir: root, readings } = await runtime.recording.snap({ devices: [name], sessionID: 'stereo' })
  assert.equal(readings[name].file, undefined)
  const rows = (await readFile(path.join(root, 'devices', name, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const row = rows.find(entry => entry.leftFile)
  assert.ok(row, JSON.stringify(rows))
  assert.equal(row.file, undefined)
  assert.notEqual(row.leftFile, row.rightFile)
  for (const file of [row.leftFile, row.rightFile]) assert.deepEqual(await readFile(path.join(root, file)), PNG)
})

test('stereo reads, sampling and localization select an eye', () => {
  execFileSync(process.env.PYTHON ?? 'python3', [fileURLToPath(new URL('./stereo_camera.py', import.meta.url))],
    { env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../assets/python', import.meta.url)), PYTHONDONTWRITEBYTECODE: '1' } })
})
