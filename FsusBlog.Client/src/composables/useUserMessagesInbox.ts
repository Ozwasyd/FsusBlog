import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  messageApi,
  type ConversationDetailResponse,
  type ConversationFilter,
  type ConversationListItemResponse,
  type ConversationMessagePreviewResponse,
  type InboxConversationClosedPayload,
  type InboxConversationUpsertPayload,
  type InboxMessageAppendPayload,
  type InboxReadUpdatedPayload
} from '@/api/message'
import { useNotification } from '@/composables/useNotification'
import type { SseInboxRenderPatch } from '@/services/sseTypes'
import { useSseStore } from '@/store/sse'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/utils/toast'

const PAGE_SIZE = 20

const toMessagePreview = (message: InboxMessageAppendPayload['message']): ConversationMessagePreviewResponse => ({
  senderType: message.senderType,
  senderName: message.senderName,
  bodyPreview: message.body.length <= 96 ? message.body : `${message.body.slice(0, 96)}...`,
  createdAt: message.createdAt
})

const toConversationListItem = (detail: ConversationDetailResponse): ConversationListItemResponse => {
  const lastMessage = detail.messages[detail.messages.length - 1] ?? null
  return {
    conversationId: detail.conversationId,
    subject: detail.subject,
    status: detail.status,
    isSystemSource: detail.isSystemSource,
    canReply: detail.canReply,
    unreadCount: detail.unreadCount,
    lastMessageAt: detail.lastMessageAt,
    updatedAt: detail.lastMessageAt,
    lastMessage: lastMessage ? toMessagePreview(lastMessage) : null
  }
}

const normalizeFilter = (value: ConversationFilter): ConversationFilter => value

const resetInboxState = (
  detailRef: { value: ConversationDetailResponse | null },
  selectionRef: { value: string },
  conversationsRef: { value: ConversationListItemResponse[] },
  replyRef: { value: string },
  createSubjectRef: { value: string },
  createBodyRef: { value: string }
) => {
  detailRef.value = null
  selectionRef.value = ''
  conversationsRef.value = []
  replyRef.value = ''
  createSubjectRef.value = ''
  createBodyRef.value = ''
}

export function useUserMessagesInbox(isEnabled: () => boolean = () => true) {
  const { unreadCount } = useNotification()
  const sseStore = useSseStore()

  const loading = ref(false)
  const loadingDetail = ref(false)
  const sending = ref(false)
  const creating = ref(false)

  const filter = ref<ConversationFilter>('all')
  const conversations = shallowRef<ConversationListItemResponse[]>([])
  const selectedConversationId = ref<string>('')
  const detail = shallowRef<ConversationDetailResponse | null>(null)

  const replyBody = ref('')
  const createSubject = ref('')
  const createBody = ref('')

  const hasSelection = computed(() => selectedConversationId.value.length > 0)

  const selectedConversation = computed(() =>
    conversations.value.find((it) => it.conversationId === selectedConversationId.value) ?? null
  )

  const refreshList = async (silent = false): Promise<boolean> => {
    if (!isEnabled()) {
      resetInboxState(detail, selectedConversationId, conversations, replyBody, createSubject, createBody)
      return true
    }

    if (!silent) loading.value = true
    try {
      const data = await messageApi.getUserConversations(1, PAGE_SIZE, normalizeFilter(filter.value))
      conversations.value = [...(data.items || [])]
      if (!selectedConversationId.value && conversations.value.length > 0) {
        selectedConversationId.value = conversations.value[0]!.conversationId
      }
      if (selectedConversationId.value) {
        const exists = conversations.value.some((it) => it.conversationId === selectedConversationId.value)
        if (!exists) {
          selectedConversationId.value = conversations.value[0]?.conversationId ?? ''
        }
      }
    } catch (error) {
      if (!silent) {
        showErrorToast(error, '消息列表加载失败')
      }
      return false
    } finally {
      loading.value = false
    }

    return true
  }

  const loadDetail = async (conversationId: string, markRead = true, silent = false): Promise<boolean> => {
    if (!isEnabled()) {
      detail.value = null
      return true
    }

    if (!conversationId) {
      detail.value = null
      return true
    }

    loadingDetail.value = true
    try {
      const payload = await messageApi.getUserConversationDetail(conversationId)
      detail.value = payload
      if (markRead && payload.unreadCount > 0) {
        await messageApi.markConversationRead(conversationId)
        applyReadPatch({
          conversationId,
          conversationUnreadCount: 0,
          lastReadMessageId: payload.messages[payload.messages.length - 1]?.messageId ?? null,
          totalUnread: Math.max(0, unreadCount.value - payload.unreadCount)
        })
      }
    } catch (error) {
      if (!silent) {
        showErrorToast(error, '消息详情加载失败')
      }
      return false
    } finally {
      loadingDetail.value = false
    }

    return true
  }

  const selectConversation = async (conversationId: string): Promise<void> => {
    if (!conversationId) return
    selectedConversationId.value = conversationId
    await loadDetail(conversationId)
  }

  const sendReply = async (): Promise<void> => {
    if (!selectedConversationId.value || !replyBody.value.trim() || sending.value) return
    sending.value = true
    try {
      const message = await messageApi.replyUserConversation(selectedConversationId.value, { body: replyBody.value })
      applyMessageAppendPatch({
        conversationId: selectedConversationId.value,
        message,
        conversationUnreadCount: 0
      })
      replyBody.value = ''
      toast.success('已发送')
    } catch (error) {
      showErrorToast(error, '回复发送失败')
    } finally {
      sending.value = false
    }
  }

  const createTicket = async (): Promise<void> => {
    if (!createBody.value.trim() || creating.value) return
    creating.value = true
    try {
      const created = await messageApi.createUserConversation({
        subject: createSubject.value || '申诉工单',
        body: createBody.value
      })
      createSubject.value = ''
      createBody.value = ''
      selectedConversationId.value = created.conversationId
      detail.value = created
      applyConversationUpsertPatch({
        conversation: toConversationListItem(created)
      })
      const listSynced = await refreshList(true)
      const detailSynced = await loadDetail(created.conversationId, false, true)
      toast.success('工单已创建')
      if (!listSynced || !detailSynced) {
        showWarningToast('工单已创建，但列表或详情同步失败，请稍后刷新', '工单已创建，但列表或详情同步失败，请稍后刷新')
      }
    } catch (error) {
      showErrorToast(error, '工单创建失败')
    } finally {
      creating.value = false
    }
  }

  const applyConversationUpsertPatch = (payload: InboxConversationUpsertPayload): void => {
    const item = payload.conversation
    if (!item?.conversationId) return

    const list = conversations.value.slice()
    const index = list.findIndex((it) => it.conversationId === item.conversationId)
    if (index >= 0) {
      list[index] = { ...list[index]!, ...item }
    } else {
      list.unshift(item)
    }
    list.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
    conversations.value = list

    if (payload.totalUnread !== undefined && payload.totalUnread !== null) {
      unreadCount.value = Math.max(0, Number(payload.totalUnread))
    }
  }

  const applyMessageAppendPatch = (payload: InboxMessageAppendPayload): void => {
    if (!payload?.conversationId || !payload.message) return
    const list = conversations.value.slice()
    const index = list.findIndex((it) => it.conversationId === payload.conversationId)
    if (index >= 0) {
      const current = list[index]!
      list[index] = {
        ...current,
        lastMessage: toMessagePreview(payload.message),
        lastMessageAt: payload.message.createdAt,
        unreadCount: payload.conversationUnreadCount ?? current.unreadCount
      }
      const moved = list.splice(index, 1)[0]!
      list.unshift(moved)
      conversations.value = list
    }

    if (detail.value && detail.value.conversationId === payload.conversationId) {
      const exists = detail.value.messages.some((it) => it.messageId === payload.message.messageId)
      if (!exists) {
        detail.value = {
          ...detail.value,
          messages: [...detail.value.messages, payload.message],
          unreadCount: payload.conversationUnreadCount ?? detail.value.unreadCount,
          lastMessageAt: payload.message.createdAt
        }
      }
    }

    if (payload.totalUnread !== undefined && payload.totalUnread !== null) {
      unreadCount.value = Math.max(0, Number(payload.totalUnread))
    }
  }

  const applyReadPatch = (payload: InboxReadUpdatedPayload): void => {
    if (!payload?.conversationId) return
    const list = conversations.value.slice()
    const index = list.findIndex((it) => it.conversationId === payload.conversationId)
    if (index >= 0) {
      list[index] = {
        ...list[index]!,
        unreadCount: Math.max(0, payload.conversationUnreadCount)
      }
      conversations.value = list
    }

    if (detail.value && detail.value.conversationId === payload.conversationId) {
      detail.value = {
        ...detail.value,
        unreadCount: Math.max(0, payload.conversationUnreadCount)
      }
    }

    if (payload.totalUnread !== undefined && payload.totalUnread !== null) {
      unreadCount.value = Math.max(0, Number(payload.totalUnread))
    }
  }

  const applyClosedPatch = (payload: InboxConversationClosedPayload): void => {
    if (!payload?.conversationId) return
    const list = conversations.value.slice()
    const index = list.findIndex((it) => it.conversationId === payload.conversationId)
    if (index >= 0) {
      list[index] = { ...list[index]!, status: payload.status, canReply: payload.status !== 2 }
      conversations.value = list
    }
    if (detail.value && detail.value.conversationId === payload.conversationId) {
      detail.value = { ...detail.value, status: payload.status, canReply: payload.status !== 2 }
    }
  }

  const consumeInboxPatches = (patches: readonly SseInboxRenderPatch[]): void => {
    for (const patch of patches) {
      switch (patch.kind) {
        case 'conversation-upsert':
          applyConversationUpsertPatch(patch.payload as InboxConversationUpsertPayload)
          break
        case 'message-append':
          applyMessageAppendPatch(patch.payload as InboxMessageAppendPayload)
          break
        case 'read-updated':
          applyReadPatch(patch.payload as InboxReadUpdatedPayload)
          break
        case 'conversation-closed':
          applyClosedPatch(patch.payload as InboxConversationClosedPayload)
          break
        case 'unread-count':
          if (typeof patch.payload === 'number') {
            unreadCount.value = patch.payload
          }
          break
        case 'reconnected':
          void refreshList(true)
          break
      }
    }
  }

  watch(
    () => filter.value,
    () => {
      if (!isEnabled()) {
        return
      }
      void refreshList()
    }
  )

  watch(
    () => sseStore.inboxRevision,
    () => {
      if (!isEnabled()) {
        return
      }
      consumeInboxPatches(sseStore.inboxBatch)
    }
  )

  watch(
    () => isEnabled(),
    (enabled) => {
      if (enabled) {
        void refreshList()
        return
      }

      resetInboxState(detail, selectedConversationId, conversations, replyBody, createSubject, createBody)
    }
  )

  onMounted(async () => {
    if (!isEnabled()) {
      return
    }

    await refreshList()
    if (selectedConversationId.value) {
      await loadDetail(selectedConversationId.value)
    }
  })

  onUnmounted(() => {
    // no-op
  })

  return {
    loading,
    loadingDetail,
    sending,
    creating,
    filter,
    conversations,
    selectedConversationId,
    selectedConversation,
    detail,
    replyBody,
    createSubject,
    createBody,
    hasSelection,
    refreshList,
    selectConversation,
    sendReply,
    createTicket
  }
}
