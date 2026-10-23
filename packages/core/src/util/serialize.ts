/**
 * Run work in its key's lane: it starts once earlier work in the lane settles, and
 * later work waits until hold(result) settles, by default the work itself.
 */
export function serialize<T>(lanes: Map<string, Promise<void>>, key: string, run: () => Promise<T>,
  hold: (result: Promise<T>) => Promise<unknown> = result => result): Promise<T> {
  const result = (lanes.get(key) ?? Promise.resolve()).then(run)
  const tail = hold(result).then(() => {}, () => {})
  lanes.set(key, tail)
  void tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key) })
  return result
}
