import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
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
import type { NotificationStreamInboxRenderPatch } from '@/services/notificationStreamTypes'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { showErrorToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { compareConversationByLastMessage, mergeConversationPages } from '@/composables/messageConversationPagination'

const PAGE_SIZE = 20
const FILTERS: readonly ConversationFilter[] = ['all', 'unread', 'system', 'open', 'pending', 'closed']

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

const upsertConversationListItem = (
  items: readonly ConversationListItemResponse[],
  item: ConversationListItemResponse
): ConversationListItemResponse[] => {
  const next = items.slice()
  const existingIndex = next.findIndex((it) => it.conversationId === item.conversationId)
  if (existingIndex >= 0) {
    next.splice(existingIndex, 1)
  }

  const insertIndex = next.findIndex((it) => compareConversationByLastMessage(item, it) < 0)
  if (insertIndex === -1) {
    next.push(item)
  } else {
    next.splice(insertIndex, 0, item)
  }

  return next
}

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

export function useAccountMessagesInbox(isEnabled: () => boolean = () => true) {
  const { unreadCount } = useNotification()
  const notificationStreamStore = useNotificationStreamStore()
  const route = useRoute()
  const router = useRouter()

  const loading = ref(false)
  const loadingDetail = ref(false)
  const sending = ref(false)
  const creating = ref(false)

  const filter = ref<ConversationFilter>('all')
  const conversations = shallowRef<ConversationListItemResponse[]>([])
  const totalConversations = ref(0)
  const nextCursor = ref<string | null>(null)
  const hasMoreConversations = ref(false)
  const loadingMoreConversations = ref(false)
  const loadedPageCount = ref(0)
  const selectedConversationId = ref<string>('')
  const detail = shallowRef<ConversationDetailResponse | null>(null)

  const replyBody = ref('')
  const replyDrafts = reactive<Record<string, string>>({})
  const pendingConversationId = ref('')
  const createSubject = ref('')
  const createBody = ref('')
  let syncingRoute = false

  const hasSelection = computed(() => selectedConversationId.value.length > 0)
  const hasCurrentReplyDraft = computed(() => Boolean(selectedConversationId.value && replyBody.value.trim()))

  const selectedConversation = computed(() =>
    conversations.value.find((it) => it.conversationId === selectedConversationId.value) ?? null
  )

  const parseFilter = (value: unknown): ConversationFilter => {
    const raw = Array.isArray(value) ? value[0] : value
    return typeof raw === 'string' && FILTERS.includes(raw as ConversationFilter) ? raw as ConversationFilter : 'all'
  }

  const hydrateQueryFromRoute = (): void => {
    filter.value = parseFilter(route.query.filter)
  }

  const syncQueryToRoute = async (): Promise<void> => {
    const query: Record<string, string> = {}
    if (filter.value !== 'all') {
      query.filter = filter.value
    }
    syncingRoute = true
    try {
      await router.replace({ name: 'UserMessage', query })
    } finally {
      syncingRoute = false
    }
  }

  const saveCurrentReplyDraft = (): void => {
    const conversationId = selectedConversationId.value
    if (!conversationId) {
      return
    }

    const draft = replyBody.value
    if (draft.trim()) {
      replyDrafts[conversationId] = draft
    } else {
      delete replyDrafts[conversationId]
    }
  }

  const loadReplyDraft = (conversationId: string): void => {
    replyBody.value = replyDrafts[conversationId] ?? ''
  }

  const resetPagination = (): void => {
    totalConversations.value = 0
    nextCursor.value = null
    hasMoreConversations.value = false
    loadedPageCount.value = 0
  }

  const refreshList = async (silent = false, preserveLoaded = false): Promise<boolean> => {
    if (!isEnabled()) {
      resetInboxState(detail, selectedConversationId, conversations, replyBody, createSubject, createBody)
      resetPagination()
      return true
    }

    if (!silent) loading.value = true
    try {
      const data = await messageApi.getAccountConversations(PAGE_SIZE, normalizeFilter(filter.value))
      if (preserveLoaded && loadedPageCount.value > 1) {
        conversations.value = mergeConversationPages(conversations.value, data.items || [])
      } else {
        conversations.value = mergeConversationPages([], data.items || [])
        nextCursor.value = data.nextCursor ?? null
        hasMoreConversations.value = Boolean(data.hasMore && data.nextCursor)
        loadedPageCount.value = 1
      }
      totalConversations.value = data.total
      if (!selectedConversationId.value && conversations.value.length > 0) {
        selectedConversationId.value = conversations.value[0]!.conversationId
      }
      if (selectedConversationId.value) {
        const exists = conversations.value.some((it) => it.conversationId === selectedConversationId.value)
        if (!exists) {
          selectedConversationId.value = conversations.value[0]?.conversationId ?? ''
        }
      }
      if (selectedConversationId.value) {
        loadReplyDraft(selectedConversationId.value)
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

  const loadMoreConversations = async (): Promise<boolean> => {
    if (!isEnabled() || loadingMoreConversations.value || !hasMoreConversations.value || !nextCursor.value) {
      return false
    }

    loadingMoreConversations.value = true
    try {
      const data = await messageApi.getAccountConversations(
        PAGE_SIZE,
        normalizeFilter(filter.value),
        nextCursor.value
      )
      conversations.value = mergeConversationPages(conversations.value, data.items || [])
      totalConversations.value = data.total
      nextCursor.value = data.nextCursor ?? null
      hasMoreConversations.value = Boolean(data.hasMore && data.nextCursor)
      loadedPageCount.value += 1
      return true
    } catch (error) {
      showErrorToast(error, '更多会话加载失败')
      return false
    } finally {
      loadingMoreConversations.value = false
    }
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
      const payload = await messageApi.getAccountConversationDetail(conversationId)
      detail.value = payload
      if (markRead && payload.unreadCount > 0) {
        await messageApi.markConversationRead(conversationId, payload.readSnapshotMessageId)
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

  const performSelectConversation = async (conversationId: string): Promise<boolean> => {
    if (!conversationId) return false
    saveCurrentReplyDraft()
    selectedConversationId.value = conversationId
    loadReplyDraft(conversationId)
    await syncQueryToRoute()
    await loadDetail(conversationId)
    return true
  }

  const selectConversation = async (conversationId: string): Promise<boolean> => {
    if (!conversationId || conversationId === selectedConversationId.value) return false
    if (hasCurrentReplyDraft.value) {
      pendingConversationId.value = conversationId
      return false
    }

    return await performSelectConversation(conversationId)
  }

  const cancelConversationSwitch = (): void => {
    pendingConversationId.value = ''
  }

  const saveDraftAndSwitch = async (): Promise<boolean> => {
    saveCurrentReplyDraft()
    const conversationId = pendingConversationId.value
    pendingConversationId.value = ''
    return conversationId ? await performSelectConversation(conversationId) : false
  }

  const discardDraftAndSwitch = async (): Promise<boolean> => {
    const currentId = selectedConversationId.value
    if (currentId) {
      delete replyDrafts[currentId]
    }
    replyBody.value = ''
    const conversationId = pendingConversationId.value
    pendingConversationId.value = ''
    return conversationId ? await performSelectConversation(conversationId) : false
  }

  const sendReply = async (): Promise<void> => {
    if (!selectedConversationId.value || !replyBody.value.trim() || sending.value) return
    sending.value = true
    try {
      const readThroughMessageId = detail.value?.readSnapshotMessageId
      if (!readThroughMessageId) {
        throw new Error('conversation_read_snapshot_missing')
      }
      const message = await messageApi.replyAccountConversation(selectedConversationId.value, {
        body: replyBody.value,
        readThroughMessageId
      })
      applyMessageAppendPatch({
        conversationId: selectedConversationId.value,
        message,
        conversationUnreadCount: detail.value?.unreadCount
      })
      delete replyDrafts[selectedConversationId.value]
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
      const created = await messageApi.createAccountConversation({
        subject: createSubject.value || '申诉工单',
        body: createBody.value
      })
      createSubject.value = ''
      createBody.value = ''
      selectedConversationId.value = created.conversationId
      loadReplyDraft(created.conversationId)
      detail.value = created
      applyConversationUpsertPatch({
        conversation: toConversationListItem(created)
      })
      await syncQueryToRoute()
      toast.success('工单已创建')
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
    let nextItem = item
    if (index >= 0) {
      nextItem = { ...list[index]!, ...item }
    }
    conversations.value = upsertConversationListItem(list, nextItem)

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

  const consumeInboxPatches = (patches: readonly NotificationStreamInboxRenderPatch[]): void => {
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
          void refreshList(true, true)
          break
      }
    }
  }

  watch(
    () => filter.value,
    async () => {
      if (!isEnabled()) {
        return
      }
      await refreshList()
      await syncQueryToRoute()
      if (selectedConversationId.value) {
        await loadDetail(selectedConversationId.value)
      }
    }
  )

  watch(
    () => replyBody.value,
    () => {
      saveCurrentReplyDraft()
    }
  )

  watch(
    () => route.query.filter,
    async () => {
      if (syncingRoute || !isEnabled()) {
        return
      }

      hydrateQueryFromRoute()
      await refreshList(true)
      if (selectedConversationId.value) {
        await loadDetail(selectedConversationId.value)
      }
    }
  )

  watch(
    () => notificationStreamStore.inboxRevision,
    () => {
      if (!isEnabled()) {
        return
      }
      consumeInboxPatches(notificationStreamStore.inboxBatch)
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
      resetPagination()
    }
  )

  onMounted(async () => {
    if (!isEnabled()) {
      return
    }

    hydrateQueryFromRoute()
    await refreshList()
    if (selectedConversationId.value) {
      await syncQueryToRoute()
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
    totalConversations,
    hasMoreConversations,
    loadingMoreConversations,
    selectedConversationId,
    selectedConversation,
    detail,
    replyBody,
    replyDrafts,
    pendingConversationId,
    hasCurrentReplyDraft,
    createSubject,
    createBody,
    hasSelection,
    refreshList,
    loadMoreConversations,
    selectConversation,
    cancelConversationSwitch,
    saveDraftAndSwitch,
    discardDraftAndSwitch,
    sendReply,
    createTicket
  }
}
