import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Kinex Python defaults to ROS Jazzy; tests without ROS opt into plain uv Python
// through a workspace `.kinex` or global configuration directory.
export async function useUv(configDirectory) {
  await mkdir(configDirectory, { recursive: true })
  await writeFile(path.join(configDirectory, 'kinex.json'), JSON.stringify({ python: { provider: 'uv' } }))
}
