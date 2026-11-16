// Reads what a Python module says about itself, without running Python: its
// docstring and each top-level function's signature and docstring, verbatim.

export interface PythonFunction { name: string; line: number; signature: string; doc: string }
export interface PythonModule { doc: string; functions: PythonFunction[] }

const OPENERS = "([{"
const CLOSERS = ")]}"
const isQuote = (char: string | undefined) => char === '"' || char === "'"

// Index just past the string literal whose opening quote is at `start`.
function stringEnd(source: string, start: number): number {
  const quote = source.startsWith(source[start]!.repeat(3), start) ? source.slice(start, start + 3) : source[start]!
  for (let i = start + quote.length; i < source.length; i++) {
    if (source[i] === "\\") i++
    else if (source.startsWith(quote, i)) return i + quote.length
    else if (quote.length === 1 && source[i] === "\n") return i
  }
  return source.length
}

const lineEnd = (source: string, start: number) => {
  const end = source.indexOf("\n", start)
  return end < 0 ? source.length : end
}

// inspect.cleandoc: the first line as written, the rest without their common indentation.
function cleanDoc(text: string): string {
  const [first = "", ...rest] = text.replace(/\t/g, "        ").split("\n")
  const indent = Math.min(...rest.filter(line => line.trim()).map(line => line.length - line.trimStart().length))
  return [first.trim(), ...rest.map(line => line.slice(Number.isFinite(indent) ? indent : 0).trimEnd())].join("\n").trim()
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\n": "" }

// The string literal statement at `start`, after blank lines and comments; "" when there is none.
function docstring(source: string, start: number): string {
  let i = start
  while (i < source.length && (/\s/.test(source[i]!) || source[i] === "#")) i = source[i] === "#" ? lineEnd(source, i) : i + 1
  const raw = /[rRuU]/.test(source[i] ?? "") && isQuote(source[i + 1])
  const open = raw ? i + 1 : i
  if (!isQuote(source[open])) return ""
  const quote = source.startsWith(source[open]!.repeat(3), open) ? 3 : 1
  const body = source.slice(open + quote, stringEnd(source, open) - quote)
  return cleanDoc(/[rR]/.test(source[i]!) && raw ? body : body.replace(/\\([\s\S])/g, (_, char: string) => ESCAPES[char] ?? char))
}

// A def's header from `start` to its colon, on one line as written, and the index after it.
function header(source: string, start: number): { signature: string; end: number } {
  let signature = "", depth = 0
  for (let i = start; i < source.length; i++) {
    const char = source[i]!
    if (char === "#") { i = lineEnd(source, i) - 1; continue }
    if (isQuote(char)) {
      const end = stringEnd(source, i)
      signature += source.slice(i, end)
      i = end - 1
      continue
    }
    if (char === ":" && depth === 0) return { signature: signature.trim(), end: i + 1 }
    if (/\s/.test(char) || char === "\\") {
      if (!/[\s(]$/.test(signature)) signature += " "
      continue
    }
    if (OPENERS.includes(char)) depth++
    // A wrapped parameter list closes without its layout's trailing comma and space.
    if (CLOSERS.includes(char)) { depth--; signature = signature.replace(/,? $/, "") }
    signature += char
  }
  return { signature: signature.trim(), end: source.length }
}

export function scanPython(source: string): PythonModule {
  const functions = new Map<string, PythonFunction>()
  let depth = 0, line = 1
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === "\n") line++
    else if (char === "#") i = lineEnd(source, i) - 1
    else if (isQuote(char)) {
      const end = stringEnd(source, i)
      line += source.slice(i, end).split("\n").length - 1
      i = end - 1
    }
    else if (OPENERS.includes(char)) depth++
    else if (CLOSERS.includes(char)) depth--
    else if (depth === 0 && (i === 0 || source[i - 1] === "\n")) {
      const name = /^(?:async[ \t]+)?def[ \t]+([A-Za-z]\w*)[ \t]*\(/.exec(source.slice(i, i + 256))?.[1]
      if (!name) continue
      const { signature, end } = header(source, i)
      // A later definition replaces an earlier one, as it does at import.
      functions.delete(name)
      functions.set(name, { name, line, signature, doc: docstring(source, end) })
    }
  }
  return { doc: docstring(source, 0), functions: [...functions.values()] }
}
