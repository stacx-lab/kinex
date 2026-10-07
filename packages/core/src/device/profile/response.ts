import { z } from "zod"

// Measured response guidance, not command limits or readiness requirements.
export const MotionResponse = z.strictObject({
  min_abs_vel: z.number().nonnegative().optional(),
  min_abs_w: z.number().nonnegative().optional(),
  min_duration_s: z.number().positive().optional(),
})
