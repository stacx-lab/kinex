import { field, section } from "./common.ts"
import { z } from "zod"

const positive = z.number().positive()
const dimension = z.number().int().positive()

export const CameraConnection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("device"), path: field(z.string().min(1)) }),
  z.strictObject({ kind: z.literal("usb"), serial: field(z.string().min(1)) }),
  z.strictObject({ kind: z.literal("url"), url: field(z.url()), camera: field(z.string().min(1)) }),
  z.strictObject({ kind: z.literal("ros"), color_topic: field(z.string().min(1)), depth_topic: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal("mock") }),
])

export const CameraDistortion = z.discriminatedUnion("model", [
  z.strictObject({ model: z.literal("none") }),
  z.strictObject({ model: z.literal("opencv_brown_conrady"), k1: z.number(), k2: z.number(), p1: z.number(), p2: z.number(), k3: z.number() }),
])
export type CameraDistortion = z.infer<typeof CameraDistortion>

const Projection = z.strictObject({
  model: z.literal("pinhole"), fx: positive, fy: positive, cx: z.number(), cy: z.number(), skew: z.number(),
})
export type CameraProjection = z.infer<typeof Projection>

// Newton inversion of the supported Brown-Conrady model. FOV uses the same
// pixel-center convention as kinex.camera.ray (outer edges are -0.5 and size-0.5).
export function cameraRay(projection: CameraProjection, distortion: CameraDistortion, u: number, v: number): [number, number, number] | undefined {
  const yd = (v - projection.cy) / projection.fy
  const xd = (u - projection.cx - projection.skew * yd) / projection.fx
  if (distortion.model === "none") return [xd, yd, 1]
  const distort = (x: number, y: number): [number, number] => {
    const r2 = x * x + y * y
    const radial = 1 + r2 * (distortion.k1 + r2 * (distortion.k2 + r2 * distortion.k3))
    return [x * radial + 2 * distortion.p1 * x * y + distortion.p2 * (r2 + 2 * x * x),
      y * radial + distortion.p1 * (r2 + 2 * y * y) + 2 * distortion.p2 * x * y]
  }
  const iterate = (x: number, y: number, remaining: number): [number, number, number] | undefined => {
    const [px, py] = distort(x, y)
    const ex = px - xd
    const ey = py - yd
    if (Math.hypot(ex, ey) < 1e-10) return [x, y, 1]
    if (remaining === 0 || !Number.isFinite(ex) || !Number.isFinite(ey)) return undefined
    const h = 1e-6
    const [hx, hy] = distort(x + h, y)
    const [vx, vy] = distort(x, y + h)
    const a = (hx - px) / h, b = (vx - px) / h, c = (hy - py) / h, d = (vy - py) / h
    const determinant = a * d - b * c
    if (Math.abs(determinant) < 1e-12) return undefined
    return iterate(x - (d * ex - b * ey) / determinant, y - (a * ey - c * ex) / determinant, remaining - 1)
  }
  return iterate(xd, yd, 30)
}

const Geometry = z.strictObject({
  width: field(dimension), height: field(dimension), fps: field(positive.nullable()),
  projection: field(Projection), distortion: field(CameraDistortion),
  fov: field(z.strictObject({ horizontal_deg: positive.max(180), vertical_deg: positive.max(180) })),
})
const derivedFov = <T extends z.infer<typeof Geometry>>(stream: T, ctx: z.RefinementCtx): T => {
  if (stream.width === "???" || stream.height === "???" || stream.projection === "???" || stream.distortion === "???")
    return { ...stream, fov: "???" }
  const { width, height, projection, distortion } = stream
  const angle = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1,
    a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0) / (Math.hypot(...a) * Math.hypot(...b)),
  ))) * 180 / Math.PI
  const left = cameraRay(projection, distortion, -0.5, (height - 1) / 2)
  const right = cameraRay(projection, distortion, width - 0.5, (height - 1) / 2)
  const top = cameraRay(projection, distortion, (width - 1) / 2, -0.5)
  const bottom = cameraRay(projection, distortion, (width - 1) / 2, height - 0.5)
  if (!left || !right || !top || !bottom) {
    ctx.addIssue({ code: "custom", message: "distortion cannot be inverted at image bounds", path: ["distortion"] })
    return stream
  }
  return { ...stream, fov: { horizontal_deg: angle(left, right), vertical_deg: angle(top, bottom) } }
}

export const CameraColor = Geometry.transform(derivedFov)
const Range = z.strictObject({ min: z.number().nonnegative(), max: positive }).refine((r) => r.min < r.max, "min must be below max")
const depthShape = {
  width: field(dimension), height: field(dimension), fps: field(positive.nullable()),
  quantity: z.enum(["z", "range"]), scale_m_per_unit: field(positive),
  invalid_value: z.number().int().min(0).max(65535),
  valid_range_m: field(Range), reliable_range_m: field(Range),
}
export const CameraDepth = z.discriminatedUnion("registration", [
  z.strictObject({ ...depthShape, registration: z.literal("color") }),
  z.strictObject({ ...depthShape, registration: z.literal("native"), projection: field(Projection), distortion: field(CameraDistortion) }),
]).superRefine((depth, ctx) => {
  if (depth.scale_m_per_unit === "???" || depth.valid_range_m === "???") return
  if (depth.valid_range_m.max > 65535 * depth.scale_m_per_unit)
    ctx.addIssue({ code: "custom", path: ["valid_range_m", "max"], message: "valid range exceeds the uint16 representation" })
})

export const CameraCalibration = {
  method: z.enum(["unknown", "factory", "introspection", "checkerboard", "charuco", "hand_eye", "survey", "manual"]).default("unknown"),
  calibrated_at: z.iso.datetime().nullable().default(null),
  needs_calibration: section.needs_calibration,
}

export function cameraMissing(value: unknown): boolean {
  if (value === "???") return true
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(([key, entry]) =>
    !["fov", "reliable_range_m"].includes(key) && cameraMissing(entry))
}
