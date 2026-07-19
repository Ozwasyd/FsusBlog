import { describe, expect, it } from 'vitest'
import {
  mapAdminConversationDetailFromPayload,
  mapAdminConversationListFromPayload,
  mapConversationDetailFromPayload,
  mapConversationDetailV2FromPayload,
  mapConversationDetailV3FromPayload,
  mapConversationListFromPayload,
  mapConversationMessageFromPayload,
  mapConversationStatusMutationResultFromPayload
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

  it('maps the admin-only account projection without changing account list layout', () => {
    const parts: Uint8Array[] = []
    const subject = append(parts, 'Admin support')
    const sender = append(parts, '账号 #42')
    const preview = append(parts, 'Account reply')
    const header = new Uint8Array(8 + 92)
    const view = new DataView(header.buffer)
    view.setInt32(0, 1, true)
    view.setInt32(4, 1, true)
    view.setBigInt64(8, 7n, true)
    view.setInt32(16, 0, true)
    view.setInt32(20, 1, true)
    view.setBigInt64(24, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    view.setBigInt64(32, BigInt(Date.parse('2026-01-03T03:04:05.000Z')), true)
    header[41] = 1
    header[42] = 1
    slice(view, 44, subject.offset, subject.length)
    view.setInt32(52, 0, true)
    view.setBigInt64(56, BigInt(Date.parse('2026-01-04T03:04:05.000Z')), true)
    header[64] = 1
    slice(view, 68, sender.offset, sender.length)
    slice(view, 76, preview.offset, preview.length)
    view.setBigInt64(84, 42n, true)
    view.setInt32(92, 1, true)

    expect(mapAdminConversationListFromPayload(withBlob(header, parts))).toMatchObject({
      total: 1,
      items: [{
        conversationId: '7',
        counterpartyAccountId: '42',
        counterpartyAccountStatus: 1,
        lastMessage: { senderName: '账号 #42' }
      }]
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
        idempotencyReplay: false,
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
      idempotencyReplay: false,
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
    detailHeader[34] = 1
    slice(view, 36, subject.offset, subject.length)
    view.setInt32(44, 1, true)
    view.setBigInt64(48, 11n, true)
    view.setBigInt64(56, 7n, true)
    view.setInt32(64, 1, true)
    view.setBigInt64(68, BigInt(Date.parse('2026-01-02T04:04:05.000Z')), true)
    detailHeader[76] = 1
    detailHeader[77] = 1
    slice(view, 80, sender.offset, sender.length)
    slice(view, 88, body.offset, body.length)

    expect(mapConversationDetailV2FromPayload(withBlob(detailHeader, parts))).toMatchObject({
      conversationId: '7',
      idempotencyReplay: true,
      readSnapshotMessageId: '11',
      subject: 'Read snapshot',
      messages: [{
        messageId: '11',
        idempotencyReplay: true,
        senderName: 'Admin',
        body: 'Visible before the response completed'
      }]
    })
  })

  it('maps the older-message cursor from conversation detail v3', () => {
    const parts: Uint8Array[] = []
    const subject = append(parts, 'Paged thread')
    const sender = append(parts, 'Admin')
    const body = append(parts, 'Old page')
    const detailHeader = new Uint8Array(52 + 4 + 48)
    const view = new DataView(detailHeader.buffer)
    view.setBigInt64(0, 7n, true)
    view.setInt32(8, 0, true)
    view.setInt32(12, 50, true)
    view.setBigInt64(16, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    view.setBigInt64(24, 99n, true)
    view.setBigInt64(32, 50n, true)
    detailHeader[40] = 0
    detailHeader[41] = 1
    detailHeader[42] = 1
    slice(view, 44, subject.offset, subject.length)
    view.setInt32(52, 1, true)
    view.setBigInt64(56, 50n, true)
    view.setBigInt64(64, 7n, true)
    view.setInt32(72, 1, true)
    view.setBigInt64(76, BigInt(Date.parse('2026-01-02T02:04:05.000Z')), true)
    detailHeader[84] = 1
    slice(view, 88, sender.offset, sender.length)
    slice(view, 96, body.offset, body.length)

    expect(mapConversationDetailV3FromPayload(withBlob(detailHeader, parts))).toMatchObject({
      conversationId: '7',
      readSnapshotMessageId: '99',
      previousCursor: '50',
      hasOlder: true,
      subject: 'Paged thread',
      messages: [{ messageId: '50', body: 'Old page' }]
    })
  })

  it('maps the admin-only detail projection and viewer-aware sender', () => {
    const parts: Uint8Array[] = []
    const subject = append(parts, 'Admin thread')
    const sender = append(parts, '账号 #42')
    const body = append(parts, 'Account body')
    const detailHeader = new Uint8Array(68 + 4 + 48)
    const view = new DataView(detailHeader.buffer)
    view.setBigInt64(0, 7n, true)
    view.setInt32(8, 0, true)
    view.setInt32(12, 1, true)
    view.setBigInt64(16, BigInt(Date.parse('2026-01-02T03:04:05.000Z')), true)
    view.setBigInt64(24, 11n, true)
    detailHeader[41] = 1
    slice(view, 44, subject.offset, subject.length)
    view.setBigInt64(52, 42n, true)
    view.setInt32(60, 2, true)
    view.setInt32(68, 1, true)
    view.setBigInt64(72, 11n, true)
    view.setBigInt64(80, 7n, true)
    view.setInt32(88, 0, true)
    view.setBigInt64(92, BigInt(Date.parse('2026-01-02T04:04:05.000Z')), true)
    detailHeader[100] = 1
    slice(view, 104, sender.offset, sender.length)
    slice(view, 112, body.offset, body.length)

    expect(mapAdminConversationDetailFromPayload(withBlob(detailHeader, parts))).toMatchObject({
      conversationId: '7',
      counterpartyAccountId: '42',
      counterpartyAccountStatus: 2,
      messages: [{ senderName: '账号 #42', body: 'Account body' }]
    })
  })

  it('maps changed and no_change status mutation results', () => {
    const changed = new Uint8Array(12)
    const changedView = new DataView(changed.buffer)
    changedView.setInt32(0, 0, true)
    changedView.setInt32(4, 2, true)
    expect(mapConversationStatusMutationResultFromPayload(changed)).toEqual({
      previousStatus: 0,
      currentStatus: 2,
      outcome: 'changed'
    })

    const noChange = changed.slice()
    const noChangeView = new DataView(noChange.buffer)
    noChangeView.setInt32(0, 2, true)
    noChange[8] = 1
    expect(mapConversationStatusMutationResultFromPayload(noChange)).toEqual({
      previousStatus: 2,
      currentStatus: 2,
      outcome: 'no_change'
    })

    noChange[9] = 1
    expect(() => mapConversationStatusMutationResultFromPayload(noChange)).toThrow('conversation_status_mutation_result_invalid')
  })
})
