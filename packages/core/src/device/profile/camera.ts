import { field } from "./common.ts"
import { z } from "zod"

const positive = z.number().positive()
const dimension = z.number().int().positive()

// Opaque calibration metadata: interpretation belongs to the camera node.
export const CameraDistortion = z.object({ model: z.string().min(1) }).catchall(z.json())
export type CameraDistortion = z.infer<typeof CameraDistortion>

const Projection = z.strictObject({
  model: z.literal("pinhole"), fx: positive, fy: positive, cx: z.number(), cy: z.number(), skew: z.number(),
})
export type CameraProjection = z.infer<typeof Projection>

// Only explicitly undistorted pinhole geometry is interpreted by core.
export function cameraRay(projection: CameraProjection, distortion: CameraDistortion, u: number, v: number): [number, number, number] | undefined {
  if (distortion.model !== "none") return undefined
  const y = (v - projection.cy) / projection.fy
  const x = (u - projection.cx - projection.skew * y) / projection.fx
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y, 1] : undefined
}

const Geometry = z.strictObject({
  width: field(dimension), height: field(dimension), fps: field(positive.nullable()),
  projection: field(Projection), distortion: field(CameraDistortion),
  fov: field(z.strictObject({ horizontal_deg: positive.max(180), vertical_deg: positive.max(180) })),
})
const derivedFov = <T extends z.infer<typeof Geometry>>(stream: T, ctx: z.RefinementCtx): T => {
  if (stream.width === "???" || stream.height === "???" || stream.projection === "???" || stream.distortion === "???")
    return stream
  if (stream.distortion.model !== "none") return stream
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
