import { describe, expect, it } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { encodeAedsFrame, writeFixedUtf8 } from '@/api/binaryFrame'
import { decodeNotificationApiErrorFrame, decodeNotificationFrame } from '@/adapters/binary/notificationAdapter'
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

  it('decodes CommentAdded author snapshots without legacy identity fields', () => {
    const payload: number[] = []
    writeInt64(payload, 77)
    writeInt64(payload, Date.parse('2026-06-21T10:00:00.000Z'))
    writeInt32(payload, NotificationStreamEventType.CommentAdded)
    writeInt32(payload, 0)
    writeValue(payload, {
      articleId: 42,
      comment: {
        id: '9001',
        content: '匿名评论',
        createTime: '2026-06-21T09:59:59.000Z',
        author: {
          mode: 'zk_anonymous',
          displayName: '青松',
          displayLanguage: 'zh-CN',
          badge: '已验证匿名凭证',
          scopeLabel: 'article:42',
          credentialLevel: 'verified'
        },
        parentId: '100',
        rootId: '100',
        replyToAuthor: {
          mode: 'anonymous',
          displayName: '海棠',
          displayLanguage: 'zh-CN'
        },
        replyToCommentId: '100',
        depth: 1,
        isDeleted: false
      },
      time: '2026-06-21T10:00:00.000Z'
    })

    const frame = encodeAedsFrame(FrameType.NotificationEvent, new Uint8Array(payload))
    const decoded = decodeNotificationFrame(frame)

    expect(decoded.kind).toBe('event')
    if (decoded.kind !== 'event') return
    expect(decoded.event.payload).toMatchObject({
      articleId: 42,
      comment: {
        id: '9001',
        author: {
          mode: 'zk_anonymous',
          displayName: '青松',
          displayLanguage: 'zh-CN',
          badge: '已验证匿名凭证',
          scopeLabel: 'article:42',
          credentialLevel: 'verified'
        },
        replyToAuthor: {
          mode: 'anonymous',
          displayName: '海棠',
          displayLanguage: 'zh-CN'
        }
      }
    })
    expect(JSON.stringify(decoded.event.payload)).not.toMatch(/\b(?:userName|replyToUserId)\b/)
  })

  it('decodes session revocation without exposing session or credential identifiers', () => {
    const payload: number[] = []
    writeInt64(payload, 88)
    writeInt64(payload, Date.parse('2026-07-15T00:00:00.000Z'))
    writeInt32(payload, NotificationStreamEventType.SessionRevoked)
    writeInt32(payload, 0)
    writeValue(payload, {
      reason: 'passkey_counter_rollback',
      revokedSessionCount: 2,
      time: '2026-07-15T00:00:00.000Z'
    })

    const frame = encodeAedsFrame(FrameType.NotificationEvent, new Uint8Array(payload))
    const decoded = decodeNotificationFrame(frame)

    expect(decoded).toEqual({
      kind: 'event',
      event: {
        id: 88,
        type: NotificationStreamEventType.SessionRevoked,
        ts: Date.parse('2026-07-15T00:00:00.000Z'),
        payload: {
          reason: 'passkey_counter_rollback',
          revokedSessionCount: 2,
          time: '2026-07-15T00:00:00.000Z'
        }
      }
    })
    expect(JSON.stringify(decoded)).not.toMatch(/sessionId|credentialId|token/i)
  })

  it('round-trips the unified conversation status changed event', () => {
    const payload: number[] = []
    writeInt64(payload, 91)
    writeInt64(payload, Date.parse('2026-07-19T00:00:00.000Z'))
    writeInt32(payload, NotificationStreamEventType.InboxConversationStatusChanged)
    writeInt32(payload, 0)
    writeValue(payload, {
      conversationId: '123',
      status: 0,
      time: '2026-07-19T00:00:00.000Z'
    })

    const frame = encodeAedsFrame(FrameType.NotificationEvent, new Uint8Array(payload))
    expect(decodeNotificationFrame(frame)).toEqual({
      kind: 'event',
      event: {
        id: 91,
        type: NotificationStreamEventType.InboxConversationStatusChanged,
        ts: Date.parse('2026-07-19T00:00:00.000Z'),
        payload: {
          conversationId: '123',
          status: 0,
          time: '2026-07-19T00:00:00.000Z'
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

  it('decodes preflight ApiError frames', () => {
    const payload = new Uint8Array(584)
    const view = new DataView(payload.buffer)
    view.setInt32(4, 403, true)
    writeFixedUtf8(payload, 8, 256, 'notification_pow_required')
    writeFixedUtf8(payload, 520, 64, 'trace-preflight-1')

    const frame = encodeAedsFrame(FrameType.ApiError, payload)

    expect(decodeNotificationApiErrorFrame(frame)).toEqual({
      status: 403,
      message: 'notification_pow_required',
      traceId: 'trace-preflight-1'
    })
  })
})
