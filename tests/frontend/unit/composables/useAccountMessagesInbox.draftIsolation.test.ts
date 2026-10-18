// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAccountMessagesInbox } from '@/composables/useAccountMessagesInbox'
import type { ConversationDetailResponse, ConversationListItemResponse, ConversationMessageResponse, messageApi } from '@/api/message'

const mocks = vi.hoisted(() => ({
  getAccountConversations: vi.fn<typeof messageApi.getAccountConversations>(),
  getAccountConversationDetail: vi.fn<typeof messageApi.getAccountConversationDetail>(),
  replyAccountConversation: vi.fn<typeof messageApi.replyAccountConversation>(),
  createAccountConversation: vi.fn<typeof messageApi.createAccountConversation>(),
  routerReplace: vi.fn(),
  routeQuery: {} as Record<string, string>,
  showErrorToast: vi.fn(),
  toastSuccess: vi.fn(),
  listFocus: vi.fn(),
  threadFocus: vi.fn()
}))

const mediaQueryState = vi.hoisted(() => ({ state: null as { isMobile: boolean } | null }))

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: mocks.routeQuery, path: '/user/messages' }),
  useRouter: () => ({
    replace: mocks.routerReplace
  })
}))

vi.mock('@/api/message', () => ({
  messageApi: {
    getAccountConversations: mocks.getAccountConversations,
    getAccountConversationDetail: mocks.getAccountConversationDetail,
    replyAccountConversation: mocks.replyAccountConversation,
    createAccountConversation: mocks.createAccountConversation
  }
}))

vi.mock('@/composables/useNotification', () => ({
  useNotification: () => ({
    unreadCount: ref(0)
  })
}))

vi.mock('@/composables/useMediaQuery', async () => {
  const { computed, reactive } = await import('vue')
  mediaQueryState.state = reactive({ isMobile: false })
  return {
    useMediaQuery: () => computed(() => mediaQueryState.state!.isMobile)
  }
})

vi.mock('@/store/notificationStream', () => ({
  useNotificationStreamStore: () => ({
    subscribe: vi.fn()
  })
}))

vi.mock('@/utils/errorPresentation', () => ({
  showErrorToast: mocks.showErrorToast
}))

vi.mock('@/fsusui/feedback', () => ({
  toast: {
    success: mocks.toastSuccess.mockImplementation(() => ({ close: vi.fn() })),
    error: vi.fn().mockReturnValue({ close: vi.fn() }),
    info: vi.fn().mockReturnValue({ close: vi.fn() }),
    warning: vi.fn().mockReturnValue({ close: vi.fn() })
  },
  showErrorToast: mocks.showErrorToast
}))

const ElButtonStub = defineComponent({
  inheritAttrs: false,
  props: {
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    type: { type: String, default: 'default' }
  },
  emits: ['click'],
  template: '<button v-bind="$attrs" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>'
})

const FsusDialogStub = defineComponent({
  inheritAttrs: false,
  props: {
    modelValue: { type: Boolean, default: false },
    title: { type: String, default: '' }
  },
  emits: ['update:modelValue', 'close'],
  template: '<div v-if="modelValue" role="dialog" :aria-label="title" class="fsus-dialog"><slot /><slot name="footer" /></div>'
})

const MessagesConversationListInteractiveStub = defineComponent({
  emits: ['select'],
  setup(_, { expose }) {
    expose({ focusPane: mocks.listFocus })
    return {}
  },
  template: '<div><button class="select-a" @click="$emit(\'select\', \'c1\')">会话 A</button><button class="select-b" @click="$emit(\'select\', \'c2\')">会话 B</button><slot /></div>'
})

const MessagesThreadPanelInteractiveStub = defineComponent({
  props: { replyBody: { type: String, default: '' } },
  emits: ['update:replyBody'],
  setup(_, { expose }) {
    expose({ focusPane: mocks.threadFocus })
    return {}
  },
  template: '<button class="edit-reply" @click="$emit(\'update:replyBody\', \'Draft from mounted thread\')">编辑回复</button>'
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const messageFixture = (
  messageId: string,
  conversationId: string,
  body: string,
  createdAt = '2026-08-01T00:00:00.000Z',
  senderType: ConversationMessageResponse['senderType'] = 1
): ConversationMessageResponse => ({ messageId, conversationId, body, createdAt, senderType })

const conversationFixture = (conversationId: string, subject: string): ConversationListItemResponse => ({
  conversationId,
  subject,
  status: 1,
  isSystemSource: false,
  canReply: true,
  unreadCount: 0,
  lastMessageAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
})

const detailFixture = (
  conversationId: string | number,
  body = `Initial message for ${conversationId}`,
  subject = `工单 ${conversationId}`
): ConversationDetailResponse => ({
  conversationId: String(conversationId),
  subject,
  status: 1,
  isSystemSource: false,
  canReply: true,
  unreadCount: 0,
  readSnapshotMessageId: `msg-${conversationId}-snapshot`,
  lastMessageAt: '2026-08-01T00:00:00.000Z',
  messages: [messageFixture(`msg-${conversationId}-1`, String(conversationId), body)]
})

async function mountInbox() {
  let inboxInstance: ReturnType<typeof useAccountMessagesInbox> | null = null
  const TestComp = defineComponent({
    setup() {
      const inbox = useAccountMessagesInbox()
      inboxInstance = inbox
      return inbox
    },
    template: '<div></div>'
  })
  const wrapper = mount(TestComp)
  await flushPromises()
  return { wrapper, inbox: inboxInstance! }
}

describe('useAccountMessagesInbox draft isolation and switch state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (mediaQueryState.state) mediaQueryState.state.isMobile = false
    mocks.routeQuery = {}
    mocks.getAccountConversations.mockResolvedValue({
      items: [
        conversationFixture('c1', '工单 1'),
        conversationFixture('c2', '工单 2')
      ],
      total: 2,
      nextCursor: null
    })
    mocks.getAccountConversationDetail.mockImplementation((id) => Promise.resolve(detailFixture(id)))
  })

  it('switches conversation directly when current conversation has clean/empty reply draft', async () => {
    const { wrapper, inbox } = await mountInbox()
    await inbox.selectConversation('c1')
    await flushPromises()

    expect(inbox.selectedConversationId.value).toBe('c1')
    expect(inbox.replyBody.value).toBe('')

    // Switch to c2 directly
    const switched = await inbox.selectConversation('c2')
    await flushPromises()

    expect(switched).toBe(true)
    expect(inbox.selectedConversationId.value).toBe('c2')
    expect(inbox.pendingConversationId.value).toBe('')
    wrapper.unmount()
  })

  it('prompts and holds pending switch when current conversation has uncommitted draft', async () => {
    const { wrapper, inbox } = await mountInbox()
    await inbox.selectConversation('c1')
    await flushPromises()

    inbox.replyBody.value = '正在编辑的回复草稿'
    expect(inbox.hasCurrentReplyDraft.value).toBe(true)

    // Attempt to select c2
    const switched = await inbox.selectConversation('c2')
    await flushPromises()

    expect(switched).toBe(false)
    expect(inbox.selectedConversationId.value).toBe('c1')
    expect(inbox.pendingConversationId.value).toBe('c2')
    wrapper.unmount()
  })

  it('cancels pending switch on cancelConversationSwitch keeping draft and conversation unchanged', async () => {
    const { wrapper, inbox } = await mountInbox()
    await inbox.selectConversation('c1')
    await flushPromises()

    inbox.replyBody.value = '草稿保留测试'
    await inbox.selectConversation('c2')

    expect(inbox.pendingConversationId.value).toBe('c2')

    inbox.cancelConversationSwitch()

    expect(inbox.pendingConversationId.value).toBe('')
    expect(inbox.selectedConversationId.value).toBe('c1')
    expect(inbox.replyBody.value).toBe('草稿保留测试')
    wrapper.unmount()
  })

  it('discards draft on discardDraftAndSwitch and switches to target conversation with empty draft', async () => {
    const { wrapper, inbox } = await mountInbox()
    await inbox.selectConversation('c1')
    await flushPromises()

    inbox.replyBody.value = '要放弃的草稿'
    await inbox.selectConversation('c2')

    const switched = await inbox.discardDraftAndSwitch()
    await flushPromises()

    expect(switched).toBe(true)
    expect(inbox.selectedConversationId.value).toBe('c2')
    expect(inbox.pendingConversationId.value).toBe('')
    expect(inbox.replyBody.value).toBe('')

    // Switching back to c1 confirms discarded draft is gone
    await inbox.selectConversation('c1')
    await flushPromises()
    expect(inbox.replyBody.value).toBe('')
    wrapper.unmount()
  })

  it('strictly isolates drafts between conversations when saving and switching', async () => {
    const { wrapper, inbox } = await mountInbox()

    // 1. In Conversation 1: type Draft 1 and save-switch to Conversation 2
    await inbox.selectConversation('c1')
    await flushPromises()

    inbox.replyBody.value = 'Draft for Conversation 1'
    await inbox.selectConversation('c2')
    expect(inbox.pendingConversationId.value).toBe('c2')

    await inbox.saveDraftAndSwitch()
    await flushPromises()

    expect(inbox.selectedConversationId.value).toBe('c2')
    expect(inbox.replyBody.value).toBe('')

    // 2. In Conversation 2: type Draft 2 and save-switch back to Conversation 1
    inbox.replyBody.value = 'Draft for Conversation 2'
    await inbox.selectConversation('c1')
    expect(inbox.pendingConversationId.value).toBe('c1')

    await inbox.saveDraftAndSwitch()
    await flushPromises()

    expect(inbox.selectedConversationId.value).toBe('c1')
    expect(inbox.replyBody.value).toBe('Draft for Conversation 1')

    // 3. Switch back to Conversation 2: Draft 2 is restored
    await inbox.selectConversation('c2')
    await inbox.saveDraftAndSwitch()
    await flushPromises()

    expect(inbox.selectedConversationId.value).toBe('c2')
    expect(inbox.replyBody.value).toBe('Draft for Conversation 2')
    wrapper.unmount()
  })

  it('guards duplicate reply submissions and clears draft on success while preserving draft on failure', async () => {
    let resolveReply: (val: ConversationMessageResponse) => void = () => {}
    mocks.replyAccountConversation.mockImplementation(() => new Promise<ConversationMessageResponse>((resolve) => {
      resolveReply = resolve
    }))

    const { wrapper, inbox } = await mountInbox()
    await inbox.selectConversation('c1')
    await flushPromises()

    inbox.replyBody.value = '回复内容'

    const p1 = inbox.sendReply()
    const p2 = inbox.sendReply()

    expect(mocks.replyAccountConversation).toHaveBeenCalledTimes(1)

    // Settle reply
    resolveReply(messageFixture('msg-c1-2', 'c1', '回复内容', '2026-08-01T00:01:00.000Z', 0))
    await Promise.all([p1, p2])

    expect(mocks.replyAccountConversation).toHaveBeenCalledTimes(1)
    expect(inbox.replyBody.value).toBe('')
    expect(mocks.toastSuccess).toHaveBeenCalled()

    // Test failure preserves replyBody
    inbox.replyBody.value = '即将失败的回复'
    mocks.replyAccountConversation.mockRejectedValueOnce(new Error('Network error'))

    await inbox.sendReply()
    await flushPromises()

    expect(inbox.replyBody.value).toBe('即将失败的回复')
    expect(mocks.showErrorToast).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ignores a late A detail response after B becomes the current selection', async () => {
    const detailA = deferred<ConversationDetailResponse>()
    mocks.getAccountConversationDetail.mockImplementation((id) => id === 'c1'
      ? detailA.promise
      : Promise.resolve(detailFixture('c2', 'B authoritative', '工单 2')))

    const { wrapper, inbox } = await mountInbox()
    const selectA = inbox.selectConversation('c1')
    await flushPromises()
    const selectB = inbox.selectConversation('c2')
    await selectB
    detailA.resolve(detailFixture('c1', 'Late A', '工单 1'))
    await selectA

    expect(inbox.selectedConversationId.value).toBe('c2')
    expect(inbox.detail.value?.conversationId).toBe('c2')
    expect(inbox.detail.value?.messages.map((message) => message.body)).toEqual(['B authoritative'])
    wrapper.unmount()
  })

  it('does not append a late A reply into B or clear the saved A draft after switching', async () => {
    const reply = deferred<ConversationMessageResponse>()
    mocks.replyAccountConversation.mockReturnValue(reply.promise)
    const { wrapper, inbox } = await mountInbox()
    await inbox.selectConversation('c1')
    inbox.replyBody.value = 'Late reply for A'

    const send = inbox.sendReply()
    await inbox.selectConversation('c2')
    await inbox.saveDraftAndSwitch()
    expect(inbox.detail.value?.conversationId).toBe('c2')

    reply.resolve(messageFixture('msg-c1-2', 'c1', 'Late reply for A', '2026-08-01T00:01:00.000Z', 0))
    await send

    expect(inbox.selectedConversationId.value).toBe('c2')
    expect(inbox.detail.value?.messages.map((message) => message.messageId)).toEqual(['msg-c2-1'])
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    await inbox.selectConversation('c1')
    expect(inbox.replyBody.value).toBe('Late reply for A')
    wrapper.unmount()
  })

  it('rejects closed, missing-snapshot, and mismatched-current replies without appending', async () => {
    const { wrapper, inbox } = await mountInbox()
    await inbox.selectConversation('c1')
    const originalMessages = [...(inbox.detail.value?.messages ?? [])]

    inbox.replyBody.value = 'Closed reply'
    inbox.detail.value = { ...inbox.detail.value!, status: 2, canReply: false }
    await inbox.sendReply()

    inbox.detail.value = { ...inbox.detail.value!, status: 1, canReply: true, readSnapshotMessageId: '' }
    inbox.replyBody.value = 'Missing snapshot reply'
    await inbox.sendReply()

    inbox.detail.value = { ...inbox.detail.value!, conversationId: 'c2', readSnapshotMessageId: 'msg-c2-snapshot' }
    inbox.replyBody.value = 'Mismatched current reply'
    await inbox.sendReply()

    expect(mocks.replyAccountConversation).not.toHaveBeenCalled()
    expect(inbox.detail.value?.messages).toEqual(originalMessages)
    expect(inbox.replyBody.value).toBe('Mismatched current reply')
    expect(mocks.showErrorToast).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('mounts Messages.vue and wires the accessible cancel, discard, and save decisions', async () => {
    const Messages = (await import('@/views/user/Messages.vue')).default

    const wrapper = mount(Messages, {
      global: {
        stubs: {
          ElButton: ElButtonStub,
          FsusDialog: FsusDialogStub,
          MessagesComposePanel: defineComponent({ template: '<div />' }),
          MessagesConversationList: MessagesConversationListInteractiveStub,
          MessagesThreadPanel: MessagesThreadPanelInteractiveStub
        }
      }
    })

    await flushPromises()

    expect(wrapper.find('.fsus-dialog').exists()).toBe(false)

    await wrapper.get('.select-a').trigger('click')
    await flushPromises()
    await wrapper.get('.edit-reply').trigger('click')
    await wrapper.get('.select-b').trigger('click')
    let dialog = wrapper.get('[role="dialog"][aria-label="当前回复尚未发送"]')
    let decisionButtons = dialog.findAll('button')
    expect(decisionButtons.map((button) => button.text())).toEqual(['取消', '放弃草稿', '保存草稿并切换'])

    await decisionButtons[0]!.trigger('click')
    expect(wrapper.find('.fsus-dialog').exists()).toBe(false)
    await wrapper.get('.select-b').trigger('click')
    expect(wrapper.find('.fsus-dialog').exists()).toBe(true)

    dialog = wrapper.get('[role="dialog"][aria-label="当前回复尚未发送"]')
    decisionButtons = dialog.findAll('button')
    mediaQueryState.state!.isMobile = true
    await nextTick()
    await decisionButtons[1]!.trigger('click')
    await flushPromises()
    expect(mocks.getAccountConversationDetail).toHaveBeenCalledWith('c2', null, expect.any(Object))
    expect(mocks.threadFocus).toHaveBeenCalled()

    mediaQueryState.state!.isMobile = false
    await nextTick()
    await wrapper.get('.edit-reply').trigger('click')
    await wrapper.get('.select-a').trigger('click')
    dialog = wrapper.get('[role="dialog"][aria-label="当前回复尚未发送"]')
    decisionButtons = dialog.findAll('button')
    mediaQueryState.state!.isMobile = true
    await nextTick()
    await decisionButtons[2]!.trigger('click')
    await flushPromises()
    expect(mocks.getAccountConversationDetail).toHaveBeenCalledWith('c1', null, expect.any(Object))
    expect(mocks.threadFocus).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.fsus-dialog').exists()).toBe(false)
    wrapper.unmount()
  }, 15_000)
})
