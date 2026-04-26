const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder()

export function encodeUtf8(value: string): Uint8Array {
  return UTF8_ENCODER.encode(value)
}

export function decodeUtf8(bytes: ArrayBufferView): string {
  return UTF8_DECODER.decode(bytes)
}
