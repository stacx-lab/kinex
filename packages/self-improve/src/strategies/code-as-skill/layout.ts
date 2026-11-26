import path from "node:path"

// What a code-as-skill run keeps beside what every run does (common/layout.ts):
//   <run>/
//     wave.js                         the workflow that starts a wave's trials as sub-agents
//     libraries/L<n>/{manifest.json, payload/{skills,tools,lib,programs,brief.md}, memory/}
//     waves/w<nnn>.json
//     trials/t<nnn>/                  a job folder: one episode of one task with one library version
//     distillations/d<nnn>/           a job folder: the records of the trials so far into the next version
//   <workspace>/.kinex/self-improve/code-as-skill/brief.md   the brief of the library installed in the workspace
export const waveScript = (root: string) => path.join(root, "wave.js")
export const librariesDir = (root: string) => path.join(root, "libraries")
export const versionDir = (root: string, version: string) => path.join(librariesDir(root), version)
export const trialsDir = (root: string) => path.join(root, "trials")
export const distillationsDir = (root: string) => path.join(root, "distillations")
export const wavesDir = (root: string) => path.join(root, "waves")
