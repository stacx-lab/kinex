import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { createKinexRuntime } from '@kinex/core'
import { Assets as CoreAssets } from '@kinex/core/installation/assets'

export const python = process.env.PYTHON ?? 'python3'
export const coreLibrary = CoreAssets.python()
export const library = fileURLToPath(new URL('../assets/python', import.meta.url))
export const fakeRos = fileURLToPath(new URL('./fake_rclpy', import.meta.url))

export function runPython(args, options = {}) {
  const result = spawnSync(python, args, {
    encoding: 'utf8', timeout: 30000, ...options,
    env: { ...process.env, PYTHONPATH: [library, coreLibrary].join(path.delimiter), PYTHONDONTWRITEBYTECODE: '1', ...options.env },
  })
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}

/** Software-only provisioning contract shared by vendor and generic bundles. */
export async function provisionBundle(t, source, { facts = {}, name, prepare } = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'kinex-bundle-'))
  const runtime = createKinexRuntime({ directory: workspace })
  t.after(async () => {
    await runtime.dispose()
    await rm(workspace, { recursive: true, force: true })
  })
  const manifest = parse(await readFile(path.join(source, 'bundle.yaml'), 'utf8'))
  const directory = path.join(workspace, '.kinex/devices', name ?? facts.name ?? manifest.name)
  await mkdir(path.dirname(directory), { recursive: true })
  const rosRoot = path.join(workspace, 'opt-ros')
  for (const distro of ['humble', 'jazzy']) {
    await mkdir(path.join(rosRoot, distro), { recursive: true })
    await writeFile(path.join(rosRoot, distro, 'setup.bash'), '# software fixture\n')
  }
  if (prepare) await prepare(directory)
  const env = { KINEX_BUNDLE_SKIP_INSTALL: '1', KINEX_BUNDLE_ROS_ROOT: rosRoot }
  const args = [path.join(source, 'provision.py'), '--dir', directory, '--core-library', coreLibrary, '--setup-library', library,
    ...Object.entries(facts).flatMap(([key, value]) => ['--fact', `${key}=${value}`])]
  const provision = () => {
    const output = runPython(args, { env })
    const result = JSON.parse(output.trim().split('\n').at(-1))
    assert.equal(result.status, 'ok', output)
    return result
  }
  const result = provision()
  const generation = Object.values(result.generations)[0]
  const profile = JSON.parse(await readFile(path.join(generation, 'profile.generated.json'), 'utf8'))
  assert.equal(profile.loaded, false)
  assert.ok(path.isAbsolute(profile.access.driver.interpreter))
  await runtime.profiles.writeDevice(profile)
  const recipe = JSON.parse(await readFile(path.join(generation, 'recipe.json'), 'utf8'))
  assert.ok(Array.isArray(recipe.nodes))
  const guide = await readFile(path.join(source, 'DEVICE.md'), 'utf8')
  for (const fact of manifest.facts.filter(entry => entry.required)) assert.ok(guide.includes(fact.key), `missing fact ${fact.key} in DEVICE.md`)
  for (const file of ['ros-python', 'stack.sh', 'check.sh', 'facts.yaml']) await readFile(path.join(generation, file))
  const before = await readFile(path.join(directory, 'state.json'), 'utf8')
  provision()
  assert.equal(await readFile(path.join(directory, 'state.json'), 'utf8'), before, 'identical facts should resume without rerunning steps')
  return { workspace, directory, generation, runtime, profile, recipe, manifest, result, env, provision }
}
