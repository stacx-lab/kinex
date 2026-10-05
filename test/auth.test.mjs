import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readlink, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { lock } from 'proper-lockfile'
import { prepareAuthPath } from '../dist/auth.js'

async function storage(t) {
  const root = await mkdtemp('/tmp/kinex-auth-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const agent = path.join(root, 'config', 'agent')
  const state = path.join(root, 'data', 'agent')
  await mkdir(agent, { recursive: true })
  await mkdir(state, { recursive: true })
  return { agent, state, auth: path.join(agent, 'auth.json'), target: path.join(state, 'auth.json') }
}

test('credential bridge handles concurrent startup, empty SDK files and shared directories', async t => {
  const { agent, state, auth, target } = await storage(t)
  await writeFile(auth, '{}')
  await Promise.all(Array.from({ length: 4 }, () => prepareAuthPath(agent, state)))
  assert.equal(path.resolve(agent, await readlink(auth)), target)
  // A dangling link allows the SDK to create the original data file on login.
  await writeFile(auth, '{"test":"credential"}')
  assert.equal(await readFile(target, 'utf8'), '{"test":"credential"}')
  assert.equal(await prepareAuthPath(agent, state), auth)
  assert.equal(await prepareAuthPath(state, state), target)
  const release = await lock(auth, { realpath: false })
  try { assert.equal(await prepareAuthPath(agent, state), auth) }
  finally { await release() }
})

test('credential bridge preserves conflicting files and links', async t => {
  const { agent, state, auth, target } = await storage(t)
  await writeFile(target, '{"data":"untouched"}')
  const conflict = '{"other":"credential"}'
  await writeFile(auth, conflict)
  await assert.rejects(prepareAuthPath(agent, state), { name: 'AuthPathConflict' })
  assert.equal(await readFile(auth, 'utf8'), conflict)
  await writeFile(auth, 'invalid-json-secret')
  await assert.rejects(prepareAuthPath(agent, state), error => {
    assert.equal(error.name, 'AuthPathConflict')
    assert.ok(!error.message.includes('invalid-json-secret'))
    return true
  })
  await rm(auth)
  await symlink('elsewhere.json', auth)
  await assert.rejects(prepareAuthPath(agent, state), { name: 'AuthPathConflict' })
  assert.equal(await readlink(auth), 'elsewhere.json')
  assert.equal(await readFile(target, 'utf8'), '{"data":"untouched"}')
})
