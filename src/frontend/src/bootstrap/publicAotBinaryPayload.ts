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
const DECIMAL_KIND = 8

export function encodePublicAotPayload(value: unknown): string {
  const payload = new BinaryWriter()
  writeValue(payload, value)
  const frame = encodeAedsFrame(FrameType.PublicAotBootstrap, payload.toUint8Array())
  return toBase64Url(frame)
}

export function decodePublicAotPayload<T>(text: string): T | null {
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(text.trim())
  } catch {
    return null
  }
  return decodePublicAotPayloadBytes<T>(bytes)
}

export function decodePublicAotPayloadBytes<T>(input: Uint8Array | ArrayBuffer): T | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
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

function writeValue(target: BinaryWriter, value: unknown): void {
  if (value === null || value === undefined) {
    target.writeByte(NULL_KIND)
    return
  }

  if (typeof value === 'string') {
    target.writeByte(STRING_KIND)
    writeString(target, value)
    return
  }

  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      target.writeByte(INT32_KIND)
      target.writeInt32(value)
      return
    }

    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      target.writeByte(INT64_KIND)
      target.writeInt64(value)
      return
    }

    target.writeByte(DOUBLE_KIND)
    target.writeDouble(value)
    return
  }

  if (typeof value === 'boolean') {
    target.writeByte(BOOL_KIND)
    target.writeByte(value ? 1 : 0)
    return
  }

  if (Array.isArray(value)) {
    target.writeByte(ARRAY_KIND)
    target.writeInt32(value.length)
    for (const item of value) writeValue(target, item)
    return
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
    target.writeByte(OBJECT_KIND)
    target.writeInt32(entries.length)
    for (const [key, item] of entries) {
      writeString(target, key)
      writeValue(target, item)
    }
    return
  }

  target.writeByte(NULL_KIND)
}

function writeString(target: BinaryWriter, value: string): void {
  const bytes = encoder.encode(value)
  target.writeInt32(bytes.byteLength)
  target.writeBytes(bytes)
}

class BinaryWriter {
  private buffer: Uint8Array
  private view: DataView
  private offset = 0

  constructor(initialCapacity = 4096) {
    this.buffer = new Uint8Array(initialCapacity)
    this.view = new DataView(this.buffer.buffer)
  }

  writeByte(value: number): void {
    this.ensure(1)
    this.buffer[this.offset] = value & 0xff
    this.offset += 1
  }

  writeBytes(value: Uint8Array): void {
    this.ensure(value.byteLength)
    this.buffer.set(value, this.offset)
    this.offset += value.byteLength
  }

  writeInt32(value: number): void {
    this.ensure(4)
    this.view.setInt32(this.offset, value, true)
    this.offset += 4
  }

  writeInt64(value: number): void {
    this.ensure(8)
    this.view.setBigInt64(this.offset, BigInt(value), true)
    this.offset += 8
  }

  writeDouble(value: number): void {
    this.ensure(8)
    this.view.setFloat64(this.offset, value, true)
    this.offset += 8
  }

  toUint8Array(): Uint8Array {
    return this.buffer.subarray(0, this.offset)
  }

  private ensure(length: number): void {
    const required = this.offset + length
    if (required <= this.buffer.byteLength) {
      return
    }

    let nextLength = this.buffer.byteLength
    while (nextLength < required) {
      nextLength *= 2
    }

    const next = new Uint8Array(nextLength)
    next.set(this.buffer.subarray(0, this.offset))
    this.buffer = next
    this.view = new DataView(this.buffer.buffer)
  }
}

function encodeAedsFrame(frameType: FrameType, payload: Uint8Array): Uint8Array {
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
  return frame
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
      case DECIMAL_KIND:
        return this.readDecimal()
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

  private readDecimal(): string {
    const lo = BigInt.asUintN(32, BigInt(this.readInt32()))
    const mid = BigInt.asUintN(32, BigInt(this.readInt32()))
    const hi = BigInt.asUintN(32, BigInt(this.readInt32()))
    const flags = this.readInt32() >>> 0
    const scale = (flags >>> 16) & 0xff
    const reservedBits = flags & 0x7f00ffff
    if (reservedBits !== 0 || scale > 28) throw new Error('public_aot_decimal_flags_invalid')

    const coefficient = (hi << 64n) | (mid << 32n) | lo
    const sign = (flags & 0x80000000) !== 0 && coefficient !== 0n ? '-' : ''
    if (scale === 0) return `${sign}${coefficient.toString()}`

    const digits = coefficient.toString().padStart(scale + 1, '0')
    return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
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
  type Base64UrlBufferConstructor = {
    from(value: Uint8Array): { toString(encoding: 'base64url'): string }
  }
  const bufferCtor = (globalThis as typeof globalThis & { Buffer?: Base64UrlBufferConstructor }).Buffer
  if (bufferCtor) {
    return bufferCtor.from(bytes).toString('base64url')
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let output = ''
  let index = 0
  for (; index + 2 < bytes.byteLength; index += 3) {
    const triplet = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0)
    output += alphabet[(triplet >>> 18) & 0x3f]
      + alphabet[(triplet >>> 12) & 0x3f]
      + alphabet[(triplet >>> 6) & 0x3f]
      + alphabet[triplet & 0x3f]
  }

  const remaining = bytes.byteLength - index
  if (remaining === 1) {
    const value = (bytes[index] ?? 0) << 16
    output += alphabet[(value >>> 18) & 0x3f] + alphabet[(value >>> 12) & 0x3f]
  } else if (remaining === 2) {
    const value = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8)
    output += alphabet[(value >>> 18) & 0x3f]
      + alphabet[(value >>> 12) & 0x3f]
      + alphabet[(value >>> 6) & 0x3f]
  }

  return output
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
