import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compile } from './compile.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
execFileSync(process.execPath, ['packages/core/script/build.mjs'], { cwd: root, stdio: 'inherit' })
execFileSync(process.execPath, ['packages/setup/script/build.mjs'], { cwd: root, stdio: 'inherit' })
await compile(root)
