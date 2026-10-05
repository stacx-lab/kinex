import { execFileSync } from 'node:child_process'
import { cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
execFileSync(process.execPath, ['packages/core/script/build.mjs'], { cwd: root, stdio: 'inherit' })
execFileSync(process.execPath, ['packages/setup/script/build.mjs'], { cwd: root, stdio: 'inherit' })
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
await cp(new URL('../src/integration/instructions.txt', import.meta.url), new URL('../dist/integration/instructions.txt', import.meta.url))
await cp(new URL('../src/integration/compaction.txt', import.meta.url), new URL('../dist/integration/compaction.txt', import.meta.url))
