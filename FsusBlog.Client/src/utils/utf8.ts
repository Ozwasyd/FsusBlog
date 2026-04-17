const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder()
const BASE64_ENCODE_CHUNK = 0x8000

export function encodeUtf8(value: string): Uint8Array {
  return UTF8_ENCODER.encode(value)
}

export function decodeUtf8(bytes: BufferSource): string {
  if (bytes instanceof ArrayBuffer) {
    return UTF8_DECODER.decode(new Uint8Array(bytes))
  }

  return UTF8_DECODER.decode(bytes)
}

export function toBinaryString(bytes: Uint8Array): string {
  let result = ''
  for (let i = 0; i < bytes.length; i += BASE64_ENCODE_CHUNK) {
    const chunk = bytes.subarray(i, i + BASE64_ENCODE_CHUNK)
    result += String.fromCharCode(...chunk)
  }
  return result
}

export function encodeJsonToBase64(value: object): string {
  return btoa(toBinaryString(encodeUtf8(JSON.stringify(value))))
}
