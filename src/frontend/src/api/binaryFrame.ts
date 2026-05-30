import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame'

export function encodeAedsFrame(frameType: FrameType, payload: Uint8Array): ArrayBuffer {
  const frame = new Uint8Array(AEDS_HEADER_LENGTH + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, AEDS_MAGIC, true)
  view.setUint8(4, AEDS_VERSION)
  view.setUint8(5, AEDS_HEADER_LENGTH)
  view.setUint16(6, 0, true)
  view.setUint16(8, frameType, true)
  view.setUint32(10, payload.byteLength, true)
  view.setUint16(14, crc16(payload), true)
  frame.set(payload, AEDS_HEADER_LENGTH)
  return frame.buffer
}

export function encodeNameMutationRequest(name: string): Uint8Array {
  const bytes = new Uint8Array(128)
  writeFixedUtf8(bytes, 0, 128, name)
  return bytes
}

export function encodeStringMutationRequest(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  const bytes = new Uint8Array(8 + 4 + encoded.byteLength)
  const view = new DataView(bytes.buffer)
  view.setInt32(0, 0, true)
  view.setInt32(4, encoded.byteLength, true)
  view.setInt32(8, encoded.byteLength, true)
  bytes.set(encoded, 12)
  return bytes
}

export function writeFixedUtf8(target: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value)
  target.set(encoded.subarray(0, length), offset)
}

function crc16(bytes: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc ^= bytes[i] ?? 0
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
    }
  }
  return crc & 0xffff
}
