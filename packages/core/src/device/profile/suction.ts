import { z } from "zod"
import { ActuatorStop, field } from "./common.ts"

// A suction tool has no joints: binary devices take release (0) or full vacuum (1),
// proportional devices any level between.
export const suctionShape = {
  vacuum: field(z.enum(["binary", "proportional"])),
  stop: field(ActuatorStop),
}
