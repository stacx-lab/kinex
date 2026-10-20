/** A protocol operation result, optionally referencing a captured artifact. */
export interface DeviceReading {
  deviceID: string
  kind: string
  data?: Record<string, unknown>
  filePath?: string
}
