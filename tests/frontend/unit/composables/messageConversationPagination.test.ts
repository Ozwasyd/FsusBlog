import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  messageApi,
  type AdminConversationDetailResponse,
  type AdminConversationListItemResponse,
  type ConversationListItemResponse,
  type ConversationMessageResponse
} from '@/api/message'
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
    getAccountConversationDelta: vi.fn(),
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

const adminConversation = (
  conversationId: string,
  lastMessageAt: string,
  subject = `conversation-${conversationId}`
): AdminConversationListItemResponse => ({
  ...conversation(conversationId, lastMessageAt, subject),
  counterpartyAccountId: conversationId,
  counterpartyAccountStatus: 0
})

const adminDetail = (
  conversationId: string,
  status: 0 | 1 | 2 = 0,
  messages: ConversationMessageResponse[] = []
): AdminConversationDetailResponse => ({
  conversationId,
  readSnapshotMessageId: messages[messages.length - 1]?.messageId ?? `${conversationId}0`,
  subject: `conversation-${conversationId}`,
  status,
  isSystemSource: false,
  canReply: status !== 2,
  unreadCount: 0,
  lastMessageAt: messages[messages.length - 1]?.createdAt ?? '2026-07-19T12:00:00Z',
  messages,
  counterpartyAccountId: conversationId,
  counterpartyAccountStatus: 0
})

const threadMessage = (messageId: string, body = messageId): ConversationMessageResponse => ({
  messageId,
  conversationId: '3',
  senderType: 1,
  senderName: '管理员',
  body,
  createdAt: `2026-07-19T12:00:${messageId.padStart(2, '0').slice(-2)}Z`
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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
    vi.mocked(messageApi.getAccountConversationDelta).mockResolvedValue({
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
    vi.mocked(messageApi.markConversationRead).mockResolvedValue(null)
    vi.mocked(messageApi.adminGetConversationDetail).mockResolvedValue({
      conversationId: '30',
      counterpartyAccountId: '30',
      counterpartyAccountStatus: 0,
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
        items: [adminConversation('30', '2026-07-19T12:00:00Z')],
        total: 2,
        nextCursor: 'admin-cursor-1',
        hasMore: true
      })
      .mockResolvedValueOnce({
        items: [adminConversation('29', '2026-07-19T11:00:00Z')],
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

  it('applies a deduplicated admin patch batch locally without reloading an unrelated detail', async () => {
    vi.mocked(messageApi.adminGetConversations).mockResolvedValue({
      items: [
        adminConversation('30', '2026-07-19T12:00:00Z'),
        adminConversation('29', '2026-07-19T11:00:00Z')
      ],
      total: 2,
      nextCursor: null,
      hasMore: false
    })
    vi.mocked(messageApi.adminGetConversationDetail).mockResolvedValue(adminDetail('30'))

    const adminCenter = mountAdminCenter()
    await flushPromises()
    vi.clearAllMocks()

    const appended = { ...threadMessage('31', 'live reply'), conversationId: '30' }
    inboxStore.inboxBatch = [
      {
        module: 'inbox', kind: 'conversation-upsert', eventId: 10,
        payload: {
          conversation: {
            ...adminConversation('30', '2026-07-19T12:00:31Z', 'patched subject'),
            lastMessage: { senderType: 1, senderName: '管理员', bodyPreview: 'live reply', createdAt: appended.createdAt }
          }
        }
      },
      {
        module: 'inbox', kind: 'conversation-upsert', eventId: 10,
        payload: { conversation: adminConversation('30', '2026-07-19T12:00:31Z', 'duplicate') }
      },
      {
        module: 'inbox', kind: 'message-append', eventId: 11,
        payload: { conversationId: '30', message: appended, conversationUnreadCount: 1 }
      },
      {
        module: 'inbox', kind: 'conversation-status-changed', eventId: 12,
        payload: { conversationId: '29', status: 1, time: '2026-07-19T12:00:32Z' }
      }
    ]
    inboxStore.inboxRevision += 1
    await flushPromises()

    expect(adminCenter.conversations.value.map((item) => item.conversationId)).toEqual(['30'])
    expect(adminCenter.conversations.value[0]?.subject).toBe('patched subject')
    expect(adminCenter.detail.value?.messages.map((message) => message.messageId)).toEqual(['31'])
    expect(messageApi.adminGetConversations).not.toHaveBeenCalled()
    expect(messageApi.adminGetConversationDetail).not.toHaveBeenCalled()
  })

  it('coalesces duplicate body-free admin events into one authoritative list and detail recovery', async () => {
    vi.mocked(messageApi.adminGetConversations).mockResolvedValue({
      items: [adminConversation('30', '2026-07-19T12:00:00Z')], total: 1, nextCursor: null, hasMore: false
    })
    vi.mocked(messageApi.adminGetConversationDetail).mockResolvedValue(adminDetail('30'))
    const adminCenter = mountAdminCenter()
    await flushPromises()
    vi.clearAllMocks()

    const authoritative = { ...threadMessage('31', 'authoritative body'), conversationId: '30' }
    vi.mocked(messageApi.adminGetConversations).mockResolvedValue({
      items: [{
        ...adminConversation('30', authoritative.createdAt),
        lastMessage: { senderType: 1, senderName: '管理员', bodyPreview: 'authoritative body', createdAt: authoritative.createdAt }
      }],
      total: 1,
      nextCursor: null,
      hasMore: false
    })
    vi.mocked(messageApi.adminGetConversationDetail).mockResolvedValue(adminDetail('30', 0, [authoritative]))
    const reference = { ...authoritative, body: '' }
    inboxStore.inboxBatch = [
      { module: 'inbox', kind: 'message-append', eventId: 20, payload: { conversationId: '30', message: reference } },
      { module: 'inbox', kind: 'message-append', eventId: 20, payload: { conversationId: '30', message: reference } }
    ]
    inboxStore.inboxRevision += 1
    await flushPromises()

    expect(messageApi.adminGetConversations).toHaveBeenCalledTimes(1)
    expect(messageApi.adminGetConversationDetail).toHaveBeenCalledTimes(1)
    expect(adminCenter.detail.value?.messages.map((message) => message.body)).toEqual(['authoritative body'])
    expect(adminCenter.detail.value?.messages.some((message) => message.body === '')).toBe(false)
  })

  it('refreshes only the list when an admin patch targets a conversation outside the loaded page', async () => {
    vi.mocked(messageApi.adminGetConversations).mockResolvedValue({
      items: [adminConversation('30', '2026-07-19T12:00:00Z')], total: 2, nextCursor: null, hasMore: false
    })
    vi.mocked(messageApi.adminGetConversationDetail).mockResolvedValue(adminDetail('30'))
    mountAdminCenter()
    await flushPromises()
    vi.clearAllMocks()
    vi.mocked(messageApi.adminGetConversations).mockResolvedValue({
      items: [
        adminConversation('99', '2026-07-19T12:00:40Z'),
        adminConversation('30', '2026-07-19T12:00:00Z')
      ],
      total: 2,
      nextCursor: null,
      hasMore: false
    })

    inboxStore.inboxBatch = [{
      module: 'inbox', kind: 'message-append', eventId: 30,
      payload: {
        conversationId: '99',
        message: { ...threadMessage('99', 'other conversation'), conversationId: '99' }
      }
    }]
    inboxStore.inboxRevision += 1
    await flushPromises()

    expect(messageApi.adminGetConversations).toHaveBeenCalledTimes(1)
    expect(messageApi.adminGetConversationDetail).not.toHaveBeenCalled()
  })

  it('prevents slow admin authority responses from overwriting a newer local patch', async () => {
    vi.mocked(messageApi.adminGetConversations).mockResolvedValue({
      items: [adminConversation('30', '2026-07-19T12:00:00Z')], total: 1, nextCursor: null, hasMore: false
    })
    vi.mocked(messageApi.adminGetConversationDetail).mockResolvedValue(adminDetail('30'))
    const adminCenter = mountAdminCenter()
    await flushPromises()
    vi.clearAllMocks()

    const slowList = deferred<Awaited<ReturnType<typeof messageApi.adminGetConversations>>>()
    const slowDetail = deferred<Awaited<ReturnType<typeof messageApi.adminGetConversationDetail>>>()
    vi.mocked(messageApi.adminGetConversations).mockReturnValue(slowList.promise)
    vi.mocked(messageApi.adminGetConversationDetail).mockReturnValue(slowDetail.promise)
    inboxStore.inboxBatch = [{
      module: 'inbox', kind: 'message-append', eventId: 40,
      payload: {
        conversationId: '30',
        message: { ...threadMessage('31', ''), conversationId: '30' }
      }
    }]
    inboxStore.inboxRevision += 1
    await flushPromises()

    inboxStore.inboxBatch = [{
      module: 'inbox', kind: 'conversation-status-changed', eventId: 41,
      payload: { conversationId: '30', status: 2, time: '2026-07-19T12:00:41Z' }
    }]
    inboxStore.inboxRevision += 1
    await flushPromises()
    expect(adminCenter.detail.value?.status).toBe(2)
    expect(adminCenter.conversations.value).toEqual([])

    const recovered = { ...threadMessage('31', 'recovered body'), conversationId: '30' }
    slowList.resolve({
      items: [adminConversation('30', '2026-07-19T12:00:00Z')], total: 1, nextCursor: null, hasMore: false
    })
    slowDetail.resolve(adminDetail('30', 0, [recovered]))
    await flushPromises()

    expect(adminCenter.conversations.value).toEqual([])
    expect(adminCenter.detail.value?.status).toBe(2)
    expect(adminCenter.detail.value?.messages.map((message) => message.body)).toEqual(['recovered body'])
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

  it('keeps the newest selection when an older detail request resolves late', async () => {
    vi.mocked(messageApi.getAccountConversations).mockResolvedValue({
      items: [
        conversation('3', '2026-07-19T12:00:00Z'),
        conversation('4', '2026-07-19T11:00:00Z'),
        conversation('5', '2026-07-19T10:00:00Z')
      ],
      total: 3,
      nextCursor: null,
      hasMore: false
    })
    const late = deferred<Awaited<ReturnType<typeof messageApi.getAccountConversationDetail>>>()
    vi.mocked(messageApi.getAccountConversationDetail)
      .mockResolvedValueOnce({
        conversationId: '3', readSnapshotMessageId: '30', subject: 'three', status: 0,
        isSystemSource: false, canReply: true, unreadCount: 0,
        lastMessageAt: '2026-07-19T12:00:00Z', messages: [threadMessage('30')]
      })
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce({
        conversationId: '5', readSnapshotMessageId: '50', subject: 'five', status: 0,
        isSystemSource: false, canReply: true, unreadCount: 0,
        lastMessageAt: '2026-07-19T12:00:50Z', messages: [{ ...threadMessage('50'), conversationId: '5' }]
      })

    const inbox = mountInbox()
    await flushPromises()
    const slowSelection = inbox.selectConversation('4')
    await flushPromises()
    await inbox.selectConversation('5')
    late.resolve({
      conversationId: '4', readSnapshotMessageId: '40', subject: 'four', status: 0,
      isSystemSource: false, canReply: true, unreadCount: 0,
      lastMessageAt: '2026-07-19T12:00:40Z', messages: [{ ...threadMessage('40'), conversationId: '4' }]
    })
    await slowSelection
    await flushPromises()

    expect(inbox.selectedConversationId.value).toBe('5')
    expect(inbox.detail.value?.conversationId).toBe('5')
    expect(inbox.detail.value?.messages.map((item) => item.messageId)).toEqual(['50'])
    const slowConfig = vi.mocked(messageApi.getAccountConversationDetail).mock.calls[1]?.[2]
    expect(slowConfig?.signal?.aborted).toBe(true)
  })

  it('rebuilds replay misses from the last message and rejects out-of-order patches', async () => {
    vi.mocked(messageApi.getAccountConversations).mockImplementation(async (size) => ({
      items: [conversation('3', '2026-07-19T12:00:12Z')],
      total: 1,
      nextCursor: null,
      hasMore: false
    }))
    vi.mocked(messageApi.getAccountConversationDetail).mockResolvedValue({
      conversationId: '3', readSnapshotMessageId: '10', subject: 'three', status: 0,
      isSystemSource: false, canReply: true, unreadCount: 2,
      lastMessageAt: '2026-07-19T12:00:10Z', messages: [threadMessage('10')]
    })
    vi.mocked(messageApi.getAccountConversationDelta).mockResolvedValue({
      conversationId: '3', readSnapshotMessageId: '12', subject: 'three', status: 0,
      isSystemSource: false, canReply: true, unreadCount: 2,
      lastMessageAt: '2026-07-19T12:00:12Z', messages: [threadMessage('11'), threadMessage('12')],
      previousCursor: null, hasOlder: false
    })

    const inbox = mountInbox()
    await flushPromises()
    inboxStore.inboxBatch = [{ module: 'inbox', kind: 'reconnected', replayMissed: true }]
    inboxStore.inboxRevision += 1
    await flushPromises()

    expect(messageApi.getAccountConversationDelta).toHaveBeenCalledWith('3', '10', expect.objectContaining({
      signal: expect.any(AbortSignal)
    }))
    expect(messageApi.getAccountConversations).toHaveBeenCalledWith(50, 'all', null)
    expect(inbox.detail.value?.messages.map((item) => item.messageId)).toEqual(['10', '11', '12'])
    expect(messageApi.markConversationRead).toHaveBeenCalledWith('3', '12', expect.any(Object))

    inboxStore.inboxBatch = [{
      module: 'inbox', kind: 'message-append', eventId: 15,
      payload: { conversationId: '3', message: threadMessage('15'), conversationUnreadCount: 1, totalUnread: 1 }
    }]
    inboxStore.inboxRevision += 1
    await flushPromises()
    inboxStore.inboxBatch = [{
      module: 'inbox', kind: 'message-append', eventId: 14,
      payload: { conversationId: '3', message: threadMessage('14'), conversationUnreadCount: 9, totalUnread: 9 }
    }]
    inboxStore.inboxRevision += 1
    await flushPromises()

    expect(inbox.detail.value?.messages.map((item) => item.messageId)).toEqual(['10', '11', '12', '14', '15'])
    expect(inbox.detail.value?.unreadCount).toBe(1)
    expect(inbox.conversations.value[0]?.lastMessage?.bodyPreview).toBe('15')
    expect(inbox.conversations.value[0]?.unreadCount).toBe(1)
  })

  it('treats body-free realtime append as a reference and reloads content from authority', async () => {
    vi.mocked(messageApi.getAccountConversations).mockResolvedValue({
      items: [conversation('3', '2026-07-19T12:00:11Z')],
      total: 1,
      nextCursor: null,
      hasMore: false
    })
    vi.mocked(messageApi.getAccountConversationDetail).mockResolvedValue({
      conversationId: '3', readSnapshotMessageId: '10', subject: 'three', status: 0,
      isSystemSource: false, canReply: true, unreadCount: 0,
      lastMessageAt: '2026-07-19T12:00:10Z', messages: [threadMessage('10')]
    })
    vi.mocked(messageApi.getAccountConversationDelta).mockResolvedValue({
      conversationId: '3', readSnapshotMessageId: '11', subject: 'three', status: 0,
      isSystemSource: false, canReply: true, unreadCount: 1,
      lastMessageAt: '2026-07-19T12:00:11Z', messages: [threadMessage('11', 'authoritative body')],
      previousCursor: null, hasOlder: false
    })

    const inbox = mountInbox()
    await flushPromises()
    inboxStore.inboxBatch = [{
      module: 'inbox', kind: 'message-append', eventId: 20,
      payload: {
        conversationId: '3',
        message: threadMessage('11', ''),
        conversationUnreadCount: 1,
        totalUnread: 1
      }
    }]
    inboxStore.inboxRevision += 1
    await flushPromises()

    expect(messageApi.getAccountConversationDelta).toHaveBeenCalledWith('3', '10', expect.objectContaining({
      signal: expect.any(AbortSignal)
    }))
    expect(inbox.detail.value?.messages.map((message) => message.body)).toEqual(['10', 'authoritative body'])
    expect(inbox.detail.value?.messages.some((message) => message.body === '')).toBe(false)
  })
})
