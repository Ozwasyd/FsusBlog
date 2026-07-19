const encoder = new TextEncoder()

export function encodeJsonRequest(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value ?? {}))
}
