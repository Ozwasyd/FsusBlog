import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { messageApi, type ConversationListItemResponse, type ConversationMessageResponse } from '@/api/message'
import { useAccountMessagesInbox } from '@/composables/useAccountMessagesInbox'
import { useAdminMessageCenter } from '@/composables/useAdminMessageCenter'
import type { NotificationStreamInboxRenderPatch } from '@/services/notificationStreamTypes'

const route = { query: {} as Record<string, string> }
const replace = vi.fn().mockResolvedValue(undefined)
const inboxStore = reactive<{
  inboxRevision: number
  inboxBatch: NotificationStreamInboxRenderPatch[]
}>({ inboxRevision: 0, inboxBatch: [] })

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ replace })
}))

vi.mock('@/api/message', () => ({
  messageApi: {
    getAccountConversations: vi.fn(),
    getAccountConversationDetail: vi.fn(),
    markConversationRead: vi.fn(),
    createAccountConversation: vi.fn(),
    replyAccountConversation: vi.fn(),
    adminGetConversations: vi.fn(),
    adminGetConversationDetail: vi.fn(),
    adminReplyConversation: vi.fn(),
    adminUpdateConversationStatus: vi.fn(),
    adminSendSystemMessage: vi.fn()
  }
}))

vi.mock('@/composables/useNotification', () => ({
  useNotification: () => ({ unreadCount: ref(0) })
}))

vi.mock('@/store/notificationStream', () => ({
  useNotificationStreamStore: () => inboxStore
}))

vi.mock('@/utils/errorPresentation', () => ({ showErrorToast: vi.fn(), showWarningToast: vi.fn() }))
vi.mock('@/fsusui/feedback', () => ({
  toast: {
    close: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    partial: vi.fn(),
    error: vi.fn()
  }
}))

const conversation = (
  conversationId: string,
  lastMessageAt: string,
  subject = `conversation-${conversationId}`
): ConversationListItemResponse => ({
  conversationId,
  subject,
  status: 0,
  isSystemSource: false,
  canReply: true,
  unreadCount: 0,
  lastMessageAt,
  updatedAt: lastMessageAt,
  lastMessage: null
})

const threadMessage = (messageId: string, body = messageId): ConversationMessageResponse => ({
  messageId,
  conversationId: '3',
  senderType: 1,
  senderName: '管理员',
  body,
  createdAt: `2026-07-19T12:00:${messageId.padStart(2, '0').slice(-2)}Z`
})

type Inbox = ReturnType<typeof useAccountMessagesInbox>
type AdminCenter = ReturnType<typeof useAdminMessageCenter>
let wrappers: VueWrapper[] = []

const mountInbox = (): Inbox => {
  let inbox!: Inbox
  const Harness = defineComponent({
    setup() {
      inbox = useAccountMessagesInbox()
      return () => h('div')
    }
  })
  wrappers.push(mount(Harness))
  return inbox
}

const mountAdminCenter = (): AdminCenter => {
  let adminCenter!: AdminCenter
  const Harness = defineComponent({
    setup() {
      adminCenter = useAdminMessageCenter()
      return () => h('div')
    }
  })
  wrappers.push(mount(Harness))
  return adminCenter
}

describe('message conversation cursor pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.query = {}
    inboxStore.inboxRevision = 0
    inboxStore.inboxBatch = []
    vi.mocked(messageApi.getAccountConversationDetail).mockResolvedValue({
      conversationId: '3',
      readSnapshotMessageId: '30',
      subject: 'conversation-3',
      status: 0,
      isSystemSource: false,
      canReply: true,
      unreadCount: 0,
      lastMessageAt: '2026-07-19T12:00:00Z',
      messages: []
    })
    vi.mocked(messageApi.adminGetConversationDetail).mockResolvedValue({
      conversationId: '30',
      readSnapshotMessageId: '300',
      subject: 'conversation-30',
      status: 0,
      isSystemSource: false,
      canReply: true,
      unreadCount: 0,
      lastMessageAt: '2026-07-19T12:00:00Z',
      messages: []
    })
  })

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount()
    wrappers = []
  })

  it('requests the next cursor and appends a sorted deduplicated page', async () => {
    vi.mocked(messageApi.getAccountConversations)
      .mockResolvedValueOnce({
        items: [
          conversation('3', '2026-07-19T12:00:00Z'),
          conversation('2', '2026-07-19T11:00:00Z', 'stale')
        ],
        total: 3,
        nextCursor: 'cursor-1',
        hasMore: true
      })
      .mockResolvedValueOnce({
        items: [
          conversation('2', '2026-07-19T11:30:00Z', 'updated'),
          conversation('1', '2026-07-19T10:00:00Z')
        ],
        total: 3,
        nextCursor: null,
        hasMore: false
      })

    const inbox = mountInbox()
    await flushPromises()
    expect(messageApi.getAccountConversations).toHaveBeenNthCalledWith(1, 20, 'all')

    inboxStore.inboxBatch = [{
      module: 'inbox',
      kind: 'conversation-upsert',
      payload: { conversation: conversation('2', '2026-07-19T13:00:00Z', 'live') }
    }]
    inboxStore.inboxRevision += 1
    await flushPromises()
    expect(inbox.conversations.value.map((item) => item.conversationId)).toEqual(['2', '3'])

    await expect(inbox.loadMoreConversations()).resolves.toBe(true)

    expect(messageApi.getAccountConversations).toHaveBeenNthCalledWith(2, 20, 'all', 'cursor-1')
    expect(inbox.conversations.value.map((item) => item.conversationId)).toEqual(['2', '3', '1'])
    expect(inbox.conversations.value.find((item) => item.conversationId === '2')?.subject).toBe('live')
    expect(inbox.hasMoreConversations.value).toBe(false)
    expect(new Set(inbox.conversations.value.map((item) => item.conversationId)).size).toBe(3)
  })

  it('resets the cursor and loaded rows when the filter changes', async () => {
    vi.mocked(messageApi.getAccountConversations)
      .mockResolvedValueOnce({
        items: [conversation('3', '2026-07-19T12:00:00Z')],
        total: 2,
        nextCursor: 'cursor-1',
        hasMore: true
      })
      .mockResolvedValueOnce({
        items: [conversation('9', '2026-07-19T09:00:00Z')],
        total: 1,
        nextCursor: null,
        hasMore: false
      })

    const inbox = mountInbox()
    await flushPromises()
    inbox.filter.value = 'closed'
    await flushPromises()

    expect(messageApi.getAccountConversations).toHaveBeenNthCalledWith(2, 20, 'closed')
    expect(inbox.conversations.value.map((item) => item.conversationId)).toEqual(['9'])
    expect(inbox.hasMoreConversations.value).toBe(false)
    await expect(inbox.loadMoreConversations()).resolves.toBe(false)
    expect(messageApi.getAccountConversations).toHaveBeenCalledTimes(2)
  })

  it('uses the admin page size and cursor for the second request', async () => {
    vi.mocked(messageApi.adminGetConversations)
      .mockResolvedValueOnce({
        items: [conversation('30', '2026-07-19T12:00:00Z')],
        total: 2,
        nextCursor: 'admin-cursor-1',
        hasMore: true
      })
      .mockResolvedValueOnce({
        items: [conversation('29', '2026-07-19T11:00:00Z')],
        total: 2,
        nextCursor: null,
        hasMore: false
      })

    const adminCenter = mountAdminCenter()
    await flushPromises()
    expect(messageApi.adminGetConversations).toHaveBeenNthCalledWith(1, 30, 'open')

    await expect(adminCenter.loadMoreConversations()).resolves.toBe(true)

    expect(messageApi.adminGetConversations).toHaveBeenNthCalledWith(2, 30, 'open', 'admin-cursor-1')
    expect(adminCenter.conversations.value.map((item) => item.conversationId)).toEqual(['30', '29'])
    expect(adminCenter.hasMoreConversations.value).toBe(false)
  })

  it('requests a real older page and merges it with a concurrent realtime message', async () => {
    vi.mocked(messageApi.getAccountConversations).mockResolvedValue({
      items: [conversation('3', '2026-07-19T12:00:00Z')],
      total: 1,
      nextCursor: null,
      hasMore: false
    })
    vi.mocked(messageApi.getAccountConversationDetail)
      .mockResolvedValueOnce({
        conversationId: '3',
        readSnapshotMessageId: '52',
        previousCursor: '51',
        hasOlder: true,
        subject: 'conversation-3',
        status: 0,
        isSystemSource: false,
        canReply: true,
        unreadCount: 0,
        lastMessageAt: '2026-07-19T12:00:52Z',
        messages: [threadMessage('51'), threadMessage('52')]
      })
      .mockResolvedValueOnce({
        conversationId: '3',
        readSnapshotMessageId: '50',
        previousCursor: null,
        hasOlder: false,
        subject: 'conversation-3',
        status: 0,
        isSystemSource: false,
        canReply: true,
        unreadCount: 0,
        lastMessageAt: '2026-07-19T12:00:52Z',
        messages: [threadMessage('1'), threadMessage('50'), threadMessage('51', 'boundary')]
      })

    const inbox = mountInbox()
    await flushPromises()
    inboxStore.inboxBatch = [{
      module: 'inbox',
      kind: 'message-append',
      payload: {
        conversationId: '3',
        message: threadMessage('1001', 'realtime')
      }
    }]
    inboxStore.inboxRevision += 1
    await flushPromises()

    await expect(inbox.loadOlderMessages()).resolves.toBe(true)

    expect(messageApi.getAccountConversationDetail).toHaveBeenNthCalledWith(2, '3', '51')
    expect(inbox.detail.value?.messages.map((item) => item.messageId)).toEqual(['1', '50', '51', '52', '1001'])
    expect(inbox.detail.value?.readSnapshotMessageId).toBe('52')
    expect(inbox.detail.value?.hasOlder).toBe(false)
  })
})
