import { execFileSync } from 'node:child_process'
import { readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { checkVersion } from '../../../script/version.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
await checkVersion(path.resolve(root, '../..'))
await rm(path.join(root, 'dist'), { recursive: true, force: true })
execFileSync(process.execPath, [path.join(root, '../../node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit' })
for (const entry of await readdir(path.join(root, 'src'), { recursive: true })) {
  if (!entry.endsWith('.txt')) continue
  const text = await readFile(path.join(root, 'src', entry), 'utf8')
  await writeFile(path.join(root, 'dist', entry + '.js'), `export default ${JSON.stringify(text)}\n`)
  await writeFile(path.join(root, 'dist', entry + '.d.ts'), 'declare const text: string; export default text\n')
}
for (const entry of await readdir(path.join(root, 'dist'), { recursive: true })) {
  if (!entry.endsWith('.js') && !entry.endsWith('.d.ts')) continue
  const file = path.join(root, 'dist', entry)
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace(/(from\s+["'][^"']+\.txt)(["'])/g, '$1.js$2').replace(/(["'])(\.[^"']*)\.ts\1/g, '$1$2.js$1'))
}
