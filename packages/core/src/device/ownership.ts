import { shortID } from "../util/id.ts"
import { scoped } from "../scope.ts"

// A tool invocation (including composed children) owns only its own references.
// Ownership survives normal write completion until replacement or explicit stop.
const owners = scoped(() => new Map<string, string>())
export function claimMotion(key: string, owner: string = shortID()) { owners().set(key, owner) }
export function ownsMotion(key: string, owner: string) { return owners().get(key) === owner }
export function ownedMotions(owner: string) { return [...owners()].filter(([, value]) => value === owner).map(([key]) => key) }
