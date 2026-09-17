import { describe, expect, it } from 'vitest'
import { mergeConversationMessagePages } from '@/composables/messageThreadPagination'
import type { ConversationMessageResponse } from '@/contracts/binaryApi'

const message = (messageId: string, body = messageId): ConversationMessageResponse => ({
  messageId,
  conversationId: '7',
  senderType: 0,
  senderName: '你',
  body,
  createdAt: '2026-07-19T08:00:00.000Z'
})

describe('message thread pagination', () => {
  it('prepends older pages, deduplicates the boundary, and preserves a concurrent new message', () => {
    const current = [message('51'), message('52'), message('1001', 'realtime')]
    const older = [message('1'), message('50'), message('51', 'boundary')]

    const merged = mergeConversationMessagePages(current, older)

    expect(merged.map((item) => item.messageId)).toEqual(['1', '50', '51', '52', '1001'])
    expect(merged.find((item) => item.messageId === '51')?.body).toBe('boundary')
    expect(merged.find((item) => item.messageId === '1001')?.body).toBe('realtime')
  })
})
