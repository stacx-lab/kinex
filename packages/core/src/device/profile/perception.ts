import { isDeepStrictEqual } from "node:util"
import { modelShape, type ModelValue } from "./model.ts"

type PerceptionType = "detection" | "segmentation"
const object = (properties: Record<string, ModelValue>, required = Object.keys(properties)): ModelValue => ({ type: "object", properties, required })

export function detectionOperation(type: PerceptionType) {
  return {
    name: "detect",
    input: object({
      image: { type: "string", format: "path" },
      prompt: { type: "string", minLength: 1 },
      min_score: { type: "number", minimum: 0, maximum: 1, default: 0.25 },
      max_results: { type: "integer", minimum: 1, default: 10 },
    }, ["image", "prompt"]),
    output: object({
      file: { type: "string", format: "path" },
      results: { type: "array", items: object({
        box: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        score: { type: "number", minimum: 0, maximum: 1 },
        label: { type: "string" },
        mask: { type: "string", format: "path" },
      }, type === "segmentation" ? ["box", "score", "label", "mask"] : ["box", "score", "label"]) },
    }, ["results"]),
  }
}

// Materialize the type-owned contract so profiles expose the complete interface.
// Additional operations remain available; detect cannot be redefined by a driver.
export function perceptionOperations(type: PerceptionType) {
  const detect = detectionOperation(type)
  return modelShape.inference_contracts.superRefine((operations, ctx) => {
    const index = operations.findIndex((operation) => operation.name === "detect")
    if (index >= 0 && !isDeepStrictEqual(operations[index], detect))
      ctx.addIssue({ code: "custom", path: [index], message: `${type} owns the detect contract; omit it or use the canonical definition` })
  }).transform((operations) => [structuredClone(detect), ...operations.filter((operation) => operation.name !== "detect")])
}
