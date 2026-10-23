// DEVICE.md structure checks: Setup and its Profile block are recognized only
// outside fenced code, so examples may contain headings.
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'

export function parseDeviceGuide(text) {
  const state = { fence: '', section: '', profile: false }
  const setup = [], profile = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (!state.fence && /^## /.test(line)) {
      const heading = line.slice(3).trim()
      if (heading === 'Setup') {
        if (seen.has(heading)) throw new Error(`duplicate ${heading} section`)
        seen.add(heading)
      }
      state.section = heading
      state.profile = false
      continue
    }
    if (state.section === 'Setup') setup.push(line)
    if (state.fence) {
      if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && !fence[2].trim()) {
        state.fence = ''
        state.profile = false
        continue
      }
      if (state.profile) profile.push(line)
      continue
    }
    if (line === '### Profile' && state.section === 'Setup') {
      if (seen.has('Profile')) throw new Error('duplicate Profile section')
      seen.add('Profile')
      state.profile = true
      continue
    }
    if (fence) {
      state.fence = fence[1]
      if (state.profile && fence[2].trim() !== 'yaml') throw new Error('Profile requires a yaml code fence')
      continue
    }
    if (state.profile && line.trim()) throw new Error('Profile must contain one YAML code block')
  }
  if (state.fence) throw new Error('unclosed code fence')
  return { setup: setup.join('\n').trim(), profile: profile.join('\n').trim() }
}

export async function readDeviceGuide(file) {
  return parseDeviceGuide(await readFile(file, 'utf8'))
}

export async function deviceGuideProfile(file) {
  const guide = await readDeviceGuide(file)
  if (!guide.profile) throw new Error(`${file}: missing Setup/Profile YAML block`)
  return parseYaml(guide.profile)
}
