import { describe, expect, it } from 'vitest'
import {
  mapConversationDetailFromPayload,
  mapConversationDetailV2FromPayload,
  mapConversationListFromPayload,
  mapConversationMessageFromPayload
} from '@/adapters/binary/messageAdapter'

const encoder = new TextEncoder()

function slice(view: DataView, offset: number, blobOffset: number, length: number): void {
  view.setInt32(offset, blobOffset, true)
  view.setInt32(offset + 4, length, true)
}

function append(parts: Uint8Array[], text: string): { offset: number; length: number } {
  const offset = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const bytes = encoder.encode(text)
  parts.push(bytes)
  return { offset, length: bytes.byteLength }
}

function withBlob(header: Uint8Array, parts: Uint8Array[]): Uint8Array {
  const blobLength = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const payload = new Uint8Array(header.byteLength + 4 + blobLength)
  const view = new DataView(payload.buffer)
  payload.set(header, 0)
  view.setInt32(header.byteLength, blobLength, true)
  let offset = header.byteLength + 4
  for (const part of parts) {
    payload.set(part, offset)
    offset += part.byteLength
  }
  return payload
}

describe('binary message adapter', () => {
  it('maps conversation list payload', () => {
    const parts: Uint8Array[] = []
    const subject = append(parts, 'Support')
    const sender = append(parts, 'Admin')
    const preview = append(parts, 'Latest reply')
    const header = new Uint8Array(8 + 76)
    const view = new DataView(header.buffer)
    view.setInt32(0, 1, true)
    view.setInt32(4, 1, true)
    view.setBigInt64(8, 7n, true)
    view.setInt32(16, 1, true)
    view.setInt32(20, 2, true)
    view.setBigInt64(24, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    view.setBigInt64(32, BigInt(Date.parse('2026-01-03T03:04:05.000Z')), true)
    header[40] = 1
    header[41] = 1
    header[42] = 1
    slice(view, 44, subject.offset, subject.length)
    view.setInt32(52, 1, true)
    view.setBigInt64(56, BigInt(Date.parse('2026-01-04T03:04:05.000Z')), true)
    header[64] = 1
    slice(view, 68, sender.offset, sender.length)
    slice(view, 76, preview.offset, preview.length)

    expect(mapConversationListFromPayload(withBlob(header, parts))).toEqual({
      total: 1,
      nextCursor: null,
      hasMore: false,
      items: [{
        conversationId: '7',
        subject: 'Support',
        status: 1,
        isSystemSource: true,
        canReply: true,
        unreadCount: 2,
        lastMessageAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-03T03:04:05.000Z',
        lastMessage: {
          senderType: 1,
          senderName: 'Admin',
          bodyPreview: 'Latest reply',
          createdAt: '2026-01-04T03:04:05.000Z'
        }
      }]
    })
  })

  it('maps conversation list cursor metadata', () => {
    const cursor = encoder.encode('opaque-next-cursor')
    const payload = new Uint8Array(17 + 8 + 4 + cursor.byteLength)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 0x4D534743, true)
    view.setInt32(4, 1, true)
    payload[8] = 1
    view.setInt32(9, 0, true)
    view.setInt32(13, cursor.byteLength, true)
    view.setInt32(17, 3, true)
    view.setInt32(21, 0, true)
    view.setInt32(25, cursor.byteLength, true)
    payload.set(cursor, 29)

    expect(mapConversationListFromPayload(payload)).toEqual({
      total: 3,
      items: [],
      nextCursor: 'opaque-next-cursor',
      hasMore: true
    })
  })

  it('maps conversation detail and single message payloads', () => {
    const parts: Uint8Array[] = []
    const subject = append(parts, 'Support')
    const sender = append(parts, 'Alice')
    const body = append(parts, 'Message body')
    const detailHeader = new Uint8Array(36 + 4 + 48)
    const view = new DataView(detailHeader.buffer)
    view.setBigInt64(0, 7n, true)
    view.setInt32(8, 0, true)
    view.setInt32(12, 1, true)
    view.setBigInt64(16, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    detailHeader[24] = 0
    detailHeader[25] = 1
    slice(view, 28, subject.offset, subject.length)
    view.setInt32(36, 1, true)
    view.setBigInt64(40, 11n, true)
    view.setBigInt64(48, 7n, true)
    view.setInt32(56, 0, true)
    view.setBigInt64(60, BigInt(Date.parse('2026-01-02T04:04:05.000Z')), true)
    detailHeader[68] = 1
    slice(view, 72, sender.offset, sender.length)
    slice(view, 80, body.offset, body.length)

    const detailPayload = withBlob(detailHeader, parts)
    expect(mapConversationDetailFromPayload(detailPayload)).toEqual({
      conversationId: '7',
      readSnapshotMessageId: '',
      subject: 'Support',
      status: 0,
      isSystemSource: false,
      canReply: true,
      unreadCount: 1,
      lastMessageAt: '2026-01-02T03:04:05.000Z',
      messages: [{
        messageId: '11',
        conversationId: '7',
        senderType: 0,
        senderName: 'Alice',
        body: 'Message body',
        createdAt: '2026-01-02T04:04:05.000Z'
      }]
    })

    const messageHeader = detailHeader.subarray(40, 88)
    expect(mapConversationMessageFromPayload(withBlob(messageHeader, parts))).toEqual({
      messageId: '11',
      conversationId: '7',
      senderType: 0,
      senderName: 'Alice',
      body: 'Message body',
      createdAt: '2026-01-02T04:04:05.000Z'
    })
  })

  it('maps the explicit read snapshot from conversation detail v2', () => {
    const parts: Uint8Array[] = []
    const subject = append(parts, 'Read snapshot')
    const sender = append(parts, 'Admin')
    const body = append(parts, 'Visible before the response completed')
    const detailHeader = new Uint8Array(44 + 4 + 48)
    const view = new DataView(detailHeader.buffer)
    view.setBigInt64(0, 7n, true)
    view.setInt32(8, 0, true)
    view.setInt32(12, 1, true)
    view.setBigInt64(16, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    view.setBigInt64(24, 11n, true)
    detailHeader[32] = 0
    detailHeader[33] = 1
    slice(view, 36, subject.offset, subject.length)
    view.setInt32(44, 1, true)
    view.setBigInt64(48, 11n, true)
    view.setBigInt64(56, 7n, true)
    view.setInt32(64, 1, true)
    view.setBigInt64(68, BigInt(Date.parse('2026-01-02T04:04:05.000Z')), true)
    detailHeader[76] = 1
    slice(view, 80, sender.offset, sender.length)
    slice(view, 88, body.offset, body.length)

    expect(mapConversationDetailV2FromPayload(withBlob(detailHeader, parts))).toMatchObject({
      conversationId: '7',
      readSnapshotMessageId: '11',
      subject: 'Read snapshot',
      messages: [{
        messageId: '11',
        senderName: 'Admin',
        body: 'Visible before the response completed'
      }]
    })
  })
})
