import { open } from "node:fs/promises"
import path from "node:path"

// Image MIME detection by magic bytes, with the extension as a fallback for
// files too short to sniff. Only formats the model providers accept as image input.
const IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

export function imageMimeBytes(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"
  return undefined
}

// The image MIME of a file, or undefined when it is not an image we can show.
export async function imageMime(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  const head = new Uint8Array(16)
  await handle.read(head, 0, 16, 0).finally(() => handle.close())
  return imageMimeBytes(head) ?? IMAGE_MIMES[path.extname(file).toLowerCase()]
}

// True when the bytes look like text (no NUL in the sample) — used to refuse
// binary files that are not images instead of returning mojibake.
export function looksBinary(sample: Uint8Array): boolean {
  return sample.includes(0)
}
