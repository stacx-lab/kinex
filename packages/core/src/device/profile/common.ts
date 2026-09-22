import { z } from "zod"

export const MISSING = "???" as const
export const may = <T extends z.ZodType>(schema: T) => z.union([schema, z.literal(MISSING)])
export const field = <T extends z.ZodType>(schema: T) => may(schema).default(MISSING)
export const known = <T>(value: T | typeof MISSING): value is T => value !== MISSING
export const Source = z.enum(["user", "calibration", "introspected", "default", "unknown"])
export type Source = z.infer<typeof Source>
export const section = { source: Source.default("unknown"), needs_calibration: z.string().min(1).nullable().optional() }
export const measured = { ...section, calibrated_at: z.iso.datetime().nullable().default(null) }

export const xyz = z.tuple([z.number(), z.number(), z.number()])
export const quaternion = z.tuple([z.number(), z.number(), z.number(), z.number()])
  .refine((q) => Math.abs(Math.hypot(...q) - 1) < 1e-6, "unit quaternion xyzw required")
export const Pose = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
  .refine((v) => Math.abs(Math.hypot(...v.slice(3)) - 1) < 1e-6, "unit quaternion required")
export const Transform = z.strictObject({ translation_m: field(xyz), rotation_xyzw: field(quaternion) })
export const Mount = Transform.extend({ parent: z.string().min(1), parent_frame: z.string().min(1) })

export function hasMissing(value: unknown): boolean {
  if (value === MISSING) return true
  if (!value || typeof value !== "object") return false
  return Object.values(value).some(hasMissing)
}

export const Tcp = z.strictObject({ kind: z.literal("tcp"), host: field(z.string().min(1)), port: field(z.number().int().min(1).max(65535)) })
export const Url = z.strictObject({ kind: z.literal("url"), url: field(z.url()), device: field(z.string().min(1)) })
export const Serial = z.strictObject({ kind: z.literal("serial"), path: field(z.string().min(1)), baud_rate: field(z.number().int().positive()) })
export const Mock = z.strictObject({ kind: z.literal("mock") })
export const StateTopic = z.strictObject({ kind: z.literal("ros"), state_topic: field(z.string().min(1)) })
export const CommandTopics = StateTopic.extend({ command_topic: field(z.string().min(1)) })
export const ControlConnection = z.discriminatedUnion("kind", [Tcp, Url, Serial, CommandTopics, Mock])
export const SensorConnection = z.discriminatedUnion("kind", [Tcp, Url, Serial, StateTopic])
export const OtherConnection = z.discriminatedUnion("kind", [Tcp, Url, Serial, StateTopic, Mock,
  z.strictObject({ kind: z.literal("device"), path: field(z.string().min(1)) }),
  z.strictObject({ kind: z.literal("process") }),
])

// Every write is a SEGMENT: the device pursues the target and reports how much
// of its own clock it spent. `for_s` bounds that; `arrive` is the arrival spec
// the device judges itself against. Core checks the shape, the driver the detail.
export const segmentFields = {
  for_s: z.number().positive(),
  arrive: z.record(z.string(), z.unknown()).optional(),
}

export const lifecycle = ["load", "unload", "status"] as const
export const observationActions = ["read", ...lifecycle] as const
export const streamActions = ["record_start", "record_stop"] as const
export const actuatedActions = [...observationActions, "write", "stop", ...streamActions] as const
export const DriverSpec = z.strictObject({
  entry: z.string().default("driver.py"), interpreter: z.string().optional(),
  actions: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)).default(["read"]),
  persistent: z.boolean().default(true), timeout_s: z.number().positive().optional(),
})
export type DriverSpec = z.infer<typeof DriverSpec>
export const driverWith = (actions: readonly [string, ...string[]]) =>
  DriverSpec.extend({ actions: z.array(z.enum(actions)).default(["read"]) }).optional()
