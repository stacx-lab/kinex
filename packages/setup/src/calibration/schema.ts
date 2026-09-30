import { z } from "zod"
import { Source } from "@kinex/core/device/profile/common"

export const CalibrationResult = z.object({
  routine: z.string(),
  robotID: z.string(),
  deviceID: z.string().optional(),
  status: z.enum(["ok", "failed"]),
  data: z.unknown().optional(),
  notes: z.string().optional(),
  meta: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    source: Source,
  }),
})
export type CalibrationResult = z.infer<typeof CalibrationResult>

export function nowMeta(source: Source): { createdAt: string; updatedAt: string; source: Source } {
  const now = new Date().toISOString()
  return { createdAt: now, updatedAt: now, source }
}
