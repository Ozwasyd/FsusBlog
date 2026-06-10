import { describe, expect, it } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { encodeAedsFrame } from '@/api/binaryFrame'
import { decodeNotificationFrame } from '@/adapters/binary/notificationAdapter'
import { NotificationStreamEventType } from '@/services/notificationStreamTypes'

const encoder = new TextEncoder()

function writeString(target: number[], value: string): void {
  const bytes = encoder.encode(value)
  writeInt32(target, bytes.byteLength)
  target.push(...bytes)
}

function writeInt32(target: number[], value: number): void {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setInt32(0, value, true)
  target.push(...bytes)
}

function writeInt64(target: number[], value: number): void {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true)
  target.push(...bytes)
}

function writeValue(target: number[], value: unknown): void {
  if (value === null || value === undefined) {
    target.push(0)
    return
  }

  if (typeof value === 'string') {
    target.push(1)
    writeString(target, value)
    return
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    target.push(2)
    writeInt32(target, value)
    return
  }

  if (typeof value === 'boolean') {
    target.push(5, value ? 1 : 0)
    return
  }

  if (Array.isArray(value)) {
    target.push(7)
    writeInt32(target, value.length)
    for (const item of value) writeValue(target, item)
    return
  }

  target.push(6)
  const entries = Object.entries(value as Record<string, unknown>)
  writeInt32(target, entries.length)
  for (const [key, fieldValue] of entries) {
    writeString(target, key)
    writeValue(target, fieldValue)
  }
}

describe('binary notification adapter', () => {
  it('decodes notification event frames', () => {
    const payload: number[] = []
    writeInt64(payload, 42)
    writeInt64(payload, Date.parse('2026-01-02T03:04:05.000Z'))
    writeInt32(payload, NotificationStreamEventType.NoticeReceived)
    writeInt32(payload, 0)
    writeValue(payload, {
      title: 'Inbox',
      unreadCount: 3,
      time: '2026-01-02T03:04:05.000Z'
    })

    const frame = encodeAedsFrame(FrameType.NotificationEvent, new Uint8Array(payload))
    expect(decodeNotificationFrame(frame)).toEqual({
      kind: 'event',
      event: {
        id: 42,
        type: NotificationStreamEventType.NoticeReceived,
        ts: Date.parse('2026-01-02T03:04:05.000Z'),
        payload: {
          title: 'Inbox',
          unreadCount: 3,
          time: '2026-01-02T03:04:05.000Z'
        }
      }
    })
  })

  it('recognizes notification heartbeat frames', () => {
    const payload: number[] = []
    writeInt64(payload, Date.now())
    const frame = encodeAedsFrame(FrameType.NotificationHeartbeat, new Uint8Array(payload))
    expect(decodeNotificationFrame(frame)).toEqual({ kind: 'heartbeat' })
  })
})
