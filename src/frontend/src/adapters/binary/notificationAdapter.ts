import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame'
import type { NotificationStreamEventV2 } from '@/services/notificationStreamTypes'
import { AppErrorCode, createAppError } from '@/utils/appError'
import { readFixedUtf8, readInt32 } from './reader'

const decoder = new TextDecoder()

const NULL_KIND = 0
const STRING_KIND = 1
const INT32_KIND = 2
const INT64_KIND = 3
const DOUBLE_KIND = 4
const BOOL_KIND = 5
const OBJECT_KIND = 6
const ARRAY_KIND = 7

export type NotificationDecodeResult =
  | { kind: 'heartbeat' }
  | { kind: 'event'; event: NotificationStreamEventV2 }

export function decodeNotificationFrame(buffer: ArrayBuffer): NotificationDecodeResult {
  const frame = decodeNotificationAedsFrame(buffer)

  if (frame.frameType === FrameType.NotificationHeartbeat) {
    return { kind: 'heartbeat' }
  }

  if (frame.frameType !== FrameType.NotificationEvent) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'notification_frame_type_unexpected')
  }

  const reader = new NotificationReader(frame.payloadView)
  const id = reader.readInt64()
  const ts = reader.readInt64()
  const type = reader.readInt32()
  reader.readInt32()
  const payload = reader.readValue()
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'notification_payload_trailing_bytes')
  }

  return {
    kind: 'event',
    event: { id, ts, type, payload } as NotificationStreamEventV2
  }
}

export function decodeNotificationApiErrorFrame(buffer: ArrayBuffer): { status: number; message: string; traceId: string } | null {
  const frame = decodeNotificationAedsFrame(buffer)
  if (frame.frameType !== FrameType.ApiError || frame.payloadView.byteLength !== 584) {
    return null
  }

  return {
    status: readInt32(frame.payloadView, 4),
    message: readFixedUtf8(frame.payloadView, 8, 256),
    traceId: readFixedUtf8(frame.payloadView, 520, 64)
  }
}

function decodeNotificationAedsFrame(buffer: ArrayBuffer): { frameType: FrameType; payloadView: Uint8Array } {
  if (buffer.byteLength < AEDS_HEADER_LENGTH) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'notification_frame_too_short')
  }

  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== AEDS_MAGIC) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'notification_frame_magic_mismatch')
  }

  const version = view.getUint8(4)
  const headerLength = view.getUint8(5)
  const frameType = view.getUint16(8, true) as FrameType
  if (version !== AEDS_VERSION) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'notification_frame_version_mismatch')
  }
  if (headerLength !== AEDS_HEADER_LENGTH) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'notification_frame_header_length_mismatch')
  }

  const payloadLength = view.getUint32(10, true)
  const payloadCrc = view.getUint16(14, true)
  const payloadOffset = AEDS_HEADER_LENGTH
  if (payloadOffset + payloadLength !== buffer.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'notification_frame_length_mismatch')
  }
  const payloadView = new Uint8Array(buffer, payloadOffset, payloadLength)
  if (crc16(payloadView) !== payloadCrc) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'notification_frame_payload_crc_mismatch')
  }

  return {
    frameType,
    payloadView
  }
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

class NotificationReader {
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
        return this.readInt64()
      case DOUBLE_KIND:
        return this.readDouble()
      case BOOL_KIND:
        return this.readByte() === 1
      case OBJECT_KIND:
        return this.readObject()
      case ARRAY_KIND:
        return this.readArray()
      default:
        throw createAppError(AppErrorCode.ProtocolFailure, 'notification_value_kind_invalid')
    }
  }

  readByte(): number {
    this.require(1)
    return this.bytes[this.offset++]
  }

  readInt32(): number {
    this.require(4)
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  readInt64(): number {
    this.require(8)
    const value = Number(this.view.getBigInt64(this.offset, true))
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
    if (length < 0) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'notification_string_length_invalid')
    }

    this.require(length)
    const value = decoder.decode(this.bytes.subarray(this.offset, this.offset + length))
    this.offset += length
    return value
  }

  private readObject(): Record<string, unknown> {
    const count = this.readInt32()
    if (count < 0) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'notification_object_count_invalid')
    }

    const value: Record<string, unknown> = {}
    for (let i = 0; i < count; i += 1) {
      const key = this.readString()
      value[key] = this.readValue()
    }
    return value
  }

  private readArray(): unknown[] {
    const count = this.readInt32()
    if (count < 0) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'notification_array_count_invalid')
    }

    const value: unknown[] = []
    for (let i = 0; i < count; i += 1) {
      value.push(this.readValue())
    }
    return value
  }

  private require(length: number): void {
    if (this.remaining() < length) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'notification_payload_truncated')
    }
  }
}
