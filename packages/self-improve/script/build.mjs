import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { checkVersion } from '../../../script/version.mjs'
import { compile } from '../../../script/compile.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
await checkVersion(path.resolve(root, '../..'))
await compile(root)
