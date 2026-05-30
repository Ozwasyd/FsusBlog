import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame'

const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
const encoder = new TextEncoder()

const NULL_KIND = 0
const STRING_KIND = 1
const INT32_KIND = 2
const INT64_KIND = 3
const DOUBLE_KIND = 4
const BOOL_KIND = 5
const OBJECT_KIND = 6
const ARRAY_KIND = 7

export function encodePublicAotPayload(value: unknown): string {
  const payload: number[] = []
  writeValue(payload, value)
  const frame = encodeAedsFrame(FrameType.PublicAotBootstrap, new Uint8Array(payload))
  return toBase64Url(new Uint8Array(frame))
}

export function decodePublicAotPayload<T>(text: string): T | null {
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(text.trim())
  } catch {
    return null
  }
  if (bytes.byteLength < AEDS_HEADER_LENGTH) {
    return null
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== AEDS_MAGIC || view.getUint8(4) !== AEDS_VERSION || view.getUint8(5) !== AEDS_HEADER_LENGTH) {
    return null
  }

  if (view.getUint16(8, true) !== FrameType.PublicAotBootstrap) {
    return null
  }

  const payloadLength = view.getUint32(10, true)
  if (AEDS_HEADER_LENGTH + payloadLength !== bytes.byteLength) {
    return null
  }
  if (crc16(bytes.subarray(AEDS_HEADER_LENGTH)) !== view.getUint16(14, true)) {
    return null
  }

  const reader = new BinaryValueReader(bytes.subarray(AEDS_HEADER_LENGTH))
  const value = reader.readValue()
  return reader.remaining() === 0 && value && typeof value === 'object' ? value as T : null
}

function writeValue(target: number[], value: unknown): void {
  if (value === null || value === undefined) {
    target.push(NULL_KIND)
    return
  }

  if (typeof value === 'string') {
    target.push(STRING_KIND)
    writeString(target, value)
    return
  }

  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      target.push(INT32_KIND)
      writeInt32(target, value)
      return
    }

    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      target.push(INT64_KIND)
      writeInt64(target, value)
      return
    }

    target.push(DOUBLE_KIND)
    writeDouble(target, value)
    return
  }

  if (typeof value === 'boolean') {
    target.push(BOOL_KIND, value ? 1 : 0)
    return
  }

  if (Array.isArray(value)) {
    target.push(ARRAY_KIND)
    writeInt32(target, value.length)
    for (const item of value) writeValue(target, item)
    return
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
    target.push(OBJECT_KIND)
    writeInt32(target, entries.length)
    for (const [key, item] of entries) {
      writeString(target, key)
      writeValue(target, item)
    }
    return
  }

  target.push(NULL_KIND)
}

function writeString(target: number[], value: string): void {
  const bytes = encoder.encode(value)
  writeInt32(target, bytes.byteLength)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    target.push(bytes[index])
  }
}

function writeInt32(target: number[], value: number): void {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setInt32(0, value, true)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    target.push(bytes[index])
  }
}

function writeInt64(target: number[], value: number): void {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    target.push(bytes[index])
  }
}

function writeDouble(target: number[], value: number): void {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value, true)
  for (let index = 0; index < bytes.byteLength; index += 1) {
    target.push(bytes[index])
  }
}

function encodeAedsFrame(frameType: FrameType, payload: Uint8Array): ArrayBuffer {
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

class BinaryValueReader {
  private readonly view: DataView
  private offset = 0
  private readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  remaining(): number {
    return this.bytes.byteLength - this.offset
  }

  readValue(): unknown {
    const kind = this.readByte()
    switch (kind) {
      case NULL_KIND:
        return null
      case STRING_KIND:
        return this.readString()
      case INT32_KIND:
        return this.readInt32()
      case INT64_KIND:
        return Number(this.readInt64())
      case DOUBLE_KIND:
        return this.readDouble()
      case BOOL_KIND:
        return this.readByte() === 1
      case OBJECT_KIND:
        return this.readObject()
      case ARRAY_KIND:
        return this.readArray()
      default:
        throw new Error('public_aot_value_kind_invalid')
    }
  }

  private readByte(): number {
    this.require(1)
    return this.bytes[this.offset++]
  }

  private readInt32(): number {
    this.require(4)
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  private readInt64(): bigint {
    this.require(8)
    const value = this.view.getBigInt64(this.offset, true)
    this.offset += 8
    return value
  }

  private readDouble(): number {
    this.require(8)
    const value = this.view.getFloat64(this.offset, true)
    this.offset += 8
    return value
  }

  private readString(): string {
    const length = this.readInt32()
    if (length < 0) throw new Error('public_aot_string_length_invalid')
    this.require(length)
    const value = decoder.decode(this.bytes.subarray(this.offset, this.offset + length))
    this.offset += length
    return value
  }

  private readObject(): Record<string, unknown> {
    const count = this.readInt32()
    if (count < 0) throw new Error('public_aot_object_count_invalid')
    const value: Record<string, unknown> = {}
    for (let i = 0; i < count; i += 1) {
      value[this.readString()] = this.readValue()
    }
    return value
  }

  private readArray(): unknown[] {
    const count = this.readInt32()
    if (count < 0) throw new Error('public_aot_array_count_invalid')
    const value: unknown[] = []
    for (let i = 0; i < count; i += 1) {
      value.push(this.readValue())
    }
    return value
  }

  private require(length: number): void {
    if (this.remaining() < length) throw new Error('public_aot_payload_truncated')
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
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
