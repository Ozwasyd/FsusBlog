import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  messageApi,
  type ConversationDetailResponse,
  type ConversationFilter,
  type ConversationListItemResponse,
  type ConversationMessageResponse,
  type ConversationMessagePreviewResponse,
  type InboxConversationStatusChangedPayload,
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
import { compareMessageId, mergeConversationMessagePages } from '@/composables/messageThreadPagination'
import { truncateMessagePreview } from '@/contracts/messageContentPolicy'

const PAGE_SIZE = 20
const FILTERS: readonly ConversationFilter[] = ['all', 'unread', 'system', 'open', 'pending', 'closed']

const toMessagePreview = (message: InboxMessageAppendPayload['message']): ConversationMessagePreviewResponse => ({
  senderType: message.senderType,
  senderName: message.senderName,
  bodyPreview: truncateMessagePreview(message.body),
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

const latestMessageId = (value: ConversationDetailResponse | null): string | null =>
  value?.messages[value.messages.length - 1]?.messageId ?? value?.readSnapshotMessageId ?? null

const newerMessageId = (left: string, right: string): string =>
  compareMessageId(left, right) >= 0 ? left : right

const newerTimestamp = (left: string, right: string): string =>
  (Date.parse(left) || 0) >= (Date.parse(right) || 0) ? left : right

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError'

type InboxPatchVersion = Readonly<{ eventId?: number, time?: number }>

const isOlderPatchVersion = (incoming: InboxPatchVersion | undefined, current: InboxPatchVersion | null): boolean => {
  if (!incoming || !current) return false
  if (incoming.eventId !== undefined && current.eventId !== undefined) return incoming.eventId < current.eventId
  if (incoming.time !== undefined && current.time !== undefined) return incoming.time < current.time
  return false
}

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
  const loadingOlderMessages = ref(false)
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
  let detailRequestController: AbortController | null = null
  let detailRequestGeneration = 0
  let selectionGeneration = 0
  let detailPatchRevision = 0
  let unreadPatchRevision = 0
  let unreadPatchVersion: InboxPatchVersion | null = null
  let replayReconcileGeneration = 0
  const highestPatchedMessageId = new Map<string, string>()
  const lastReadCursor = new Map<string, string>()
  const lastStatusTime = new Map<string, number>()

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
      const selectionBeforeRefresh = selectedConversationId.value
      const data = await messageApi.getAccountConversations(PAGE_SIZE, normalizeFilter(filter.value))
      if (preserveLoaded) {
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
      if (selectedConversationId.value !== selectionBeforeRefresh) {
        selectionGeneration += 1
        detailRequestController?.abort()
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

    detailRequestController?.abort()
    const controller = new AbortController()
    detailRequestController = controller
    const generation = ++detailRequestGeneration
    const patchRevisionAtStart = detailPatchRevision
    loadingDetail.value = true
    try {
      const payload = await messageApi.getAccountConversationDetail(conversationId, null, { signal: controller.signal })
      if (controller.signal.aborted || generation !== detailRequestGeneration || selectedConversationId.value !== conversationId) {
        return false
      }

      const current = detail.value?.conversationId === conversationId ? detail.value : null
      if (current && detailPatchRevision !== patchRevisionAtStart) {
        const currentReadSnapshot = current.readSnapshotMessageId || payload.readSnapshotMessageId
        detail.value = {
          ...payload,
          ...current,
          readSnapshotMessageId: newerMessageId(currentReadSnapshot, payload.readSnapshotMessageId),
          lastMessageAt: newerTimestamp(current.lastMessageAt, payload.lastMessageAt),
          messages: mergeConversationMessagePages(payload.messages, current.messages)
        }
      } else {
        detail.value = payload
      }

      const readSnapshotMessageId = detail.value.readSnapshotMessageId
      const knownRead = lastReadCursor.get(conversationId)
      lastReadCursor.set(conversationId, knownRead ? newerMessageId(knownRead, readSnapshotMessageId) : readSnapshotMessageId)
      if (markRead && detail.value.unreadCount > 0) {
        await messageApi.markConversationRead(conversationId, readSnapshotMessageId, { signal: controller.signal })
      }
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error) && !silent) {
        showErrorToast(error, '消息详情加载失败')
      }
      return false
    } finally {
      if (generation === detailRequestGeneration) {
        loadingDetail.value = false
      }
    }

    return true
  }

  const refreshUnreadFromAuthority = async (reconcileGeneration: number): Promise<void> => {
    const patchRevisionAtStart = unreadPatchRevision
    let cursor: string | null = null
    let total = 0
    const seenCursors = new Set<string>()
    do {
      const page = await messageApi.getAccountConversations(50, 'all', cursor)
      if (reconcileGeneration !== replayReconcileGeneration || !isEnabled()) return
      total += (page.items ?? []).reduce((sum, item) => sum + Math.max(0, item.unreadCount), 0)
      const next = page.hasMore ? page.nextCursor ?? null : null
      if (!next || seenCursors.has(next)) {
        cursor = null
      } else {
        seenCursors.add(next)
        cursor = next
      }
    } while (cursor)

    if (patchRevisionAtStart === unreadPatchRevision) {
      unreadCount.value = total
      unreadPatchVersion = { time: Date.now() }
    }
  }

  const loadMissedMessages = async (
    conversationId: string,
    afterMessageId: string | null,
    reconcileGeneration: number
  ): Promise<boolean> => {
    if (!afterMessageId) {
      return loadDetail(conversationId, true, true)
    }

    detailRequestController?.abort()
    const controller = new AbortController()
    detailRequestController = controller
    const generation = ++detailRequestGeneration
    const patchRevisionAtStart = detailPatchRevision
    let cursor = afterMessageId
    let authoritative: ConversationDetailResponse | null = null
    let recovered: ConversationMessageResponse[] = []
    const seenCursors = new Set<string>([cursor])
    loadingDetail.value = true

    try {
      do {
        const page = await messageApi.getAccountConversationDelta(conversationId, cursor, { signal: controller.signal })
        if (controller.signal.aborted || generation !== detailRequestGeneration ||
          reconcileGeneration !== replayReconcileGeneration || selectedConversationId.value !== conversationId) {
          return false
        }
        authoritative = page
        recovered = mergeConversationMessagePages(recovered, page.messages)
        const nextCursor = page.previousCursor ?? page.readSnapshotMessageId
        if (!page.hasOlder || !nextCursor || compareMessageId(nextCursor, cursor) <= 0 || seenCursors.has(nextCursor)) {
          break
        }
        seenCursors.add(nextCursor)
        cursor = nextCursor
      } while (true)

      if (!authoritative) return false
      const current = detail.value?.conversationId === conversationId ? detail.value : null
      const currentMessages = current?.messages ?? []
      const mergedMessages = mergeConversationMessagePages(currentMessages, recovered)
      const currentReadSnapshot = current?.readSnapshotMessageId ?? afterMessageId
      const readSnapshotMessageId = newerMessageId(currentReadSnapshot, authoritative.readSnapshotMessageId)
      detail.value = detailPatchRevision === patchRevisionAtStart || !current
        ? { ...authoritative, readSnapshotMessageId, messages: mergedMessages }
        : {
            ...authoritative,
            ...current,
            readSnapshotMessageId,
            lastMessageAt: newerTimestamp(current.lastMessageAt, authoritative.lastMessageAt),
            messages: mergedMessages
          }
      lastReadCursor.set(conversationId, readSnapshotMessageId)
      if (detail.value.unreadCount > 0) {
        await messageApi.markConversationRead(conversationId, readSnapshotMessageId, { signal: controller.signal })
      }
      return true
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) {
        showErrorToast(error, '消息重连恢复失败')
      }
      return false
    } finally {
      if (generation === detailRequestGeneration) loadingDetail.value = false
    }
  }

  const reconcileAfterReplayMiss = async (): Promise<void> => {
    const reconcileGeneration = ++replayReconcileGeneration
    const conversationId = selectedConversationId.value
    const afterMessageId = latestMessageId(detail.value)
    await Promise.allSettled([
      refreshList(true, true),
      refreshUnreadFromAuthority(reconcileGeneration),
      conversationId ? loadMissedMessages(conversationId, afterMessageId, reconcileGeneration) : Promise.resolve(false)
    ])
  }

  const loadOlderMessages = async (): Promise<boolean> => {
    const current = detail.value
    const conversationId = selectedConversationId.value
    if (!current || !conversationId || loadingOlderMessages.value || !current.hasOlder || !current.previousCursor) {
      return false
    }

    const cursor = current.previousCursor
    loadingOlderMessages.value = true
    try {
      const older = await messageApi.getAccountConversationDetail(conversationId, cursor)
      const latest = detail.value
      if (!latest || latest.conversationId !== conversationId || selectedConversationId.value !== conversationId) {
        return false
      }
      detail.value = {
        ...latest,
        previousCursor: older.previousCursor ?? null,
        hasOlder: Boolean(older.hasOlder),
        messages: mergeConversationMessagePages(latest.messages, older.messages)
      }
      return true
    } catch (error) {
      showErrorToast(error, '更早消息加载失败')
      return false
    } finally {
      loadingOlderMessages.value = false
    }
  }

  const performSelectConversation = async (conversationId: string): Promise<boolean> => {
    if (!conversationId) return false
    saveCurrentReplyDraft()
    const generation = ++selectionGeneration
    detailRequestController?.abort()
    selectedConversationId.value = conversationId
    loadReplyDraft(conversationId)
    await syncQueryToRoute()
    if (generation !== selectionGeneration || selectedConversationId.value !== conversationId) return false
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
      selectionGeneration += 1
      detailRequestController?.abort()
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

  const applyTotalUnread = (value: number | null | undefined, version?: InboxPatchVersion): void => {
    if (value === undefined || value === null) return
    if (isOlderPatchVersion(version, unreadPatchVersion)) return
    if (version) unreadPatchVersion = version
    unreadPatchRevision += 1
    unreadCount.value = Math.max(0, Number(value))
  }

  const applyConversationUpsertPatch = (payload: InboxConversationUpsertPayload, version?: InboxPatchVersion): void => {
    const item = payload.conversation
    if (!item?.conversationId) return

    const list = conversations.value.slice()
    const index = list.findIndex((it) => it.conversationId === item.conversationId)
    let nextItem = item
    if (index >= 0) {
      if (compareConversationByLastMessage(item, list[index]!) > 0) {
        applyTotalUnread(payload.totalUnread, version)
        return
      }
      nextItem = { ...list[index]!, ...item }
    }
    conversations.value = upsertConversationListItem(list, nextItem)

    applyTotalUnread(payload.totalUnread, version)
  }

  const applyMessageAppendPatch = (payload: InboxMessageAppendPayload, version?: InboxPatchVersion): void => {
    if (!payload?.conversationId || !payload.message) return
    if (!payload.message.body) {
      applyTotalUnread(payload.totalUnread, version)
      void reconcileAfterReplayMiss()
      return
    }
    const priorMessageId = highestPatchedMessageId.get(payload.conversationId)
    const isNewestPatch = !priorMessageId || compareMessageId(payload.message.messageId, priorMessageId) >= 0
    if (isNewestPatch) highestPatchedMessageId.set(payload.conversationId, payload.message.messageId)
    const list = conversations.value.slice()
    const index = list.findIndex((it) => it.conversationId === payload.conversationId)
    if (index >= 0 && isNewestPatch &&
      (Date.parse(payload.message.createdAt) || 0) >= (Date.parse(list[index]!.lastMessageAt) || 0)) {
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
      detailPatchRevision += 1
      const currentLatestMessageId = latestMessageId(detail.value)
      const advancesDetail = !currentLatestMessageId || compareMessageId(payload.message.messageId, currentLatestMessageId) >= 0
      detail.value = {
        ...detail.value,
        messages: mergeConversationMessagePages(detail.value.messages, [payload.message]),
        unreadCount: advancesDetail ? payload.conversationUnreadCount ?? detail.value.unreadCount : detail.value.unreadCount,
        lastMessageAt: advancesDetail
          ? newerTimestamp(payload.message.createdAt, detail.value.lastMessageAt)
          : detail.value.lastMessageAt
      }
    }

    if (isNewestPatch) applyTotalUnread(payload.totalUnread, version)
  }

  const applyReadPatch = (payload: InboxReadUpdatedPayload, version?: InboxPatchVersion): void => {
    if (!payload?.conversationId) return
    const incomingCursor = payload.lastReadMessageId ?? null
    const knownCursor = lastReadCursor.get(payload.conversationId)
    if (incomingCursor && knownCursor && compareMessageId(incomingCursor, knownCursor) < 0) return
    if (incomingCursor) lastReadCursor.set(payload.conversationId, incomingCursor)
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
      detailPatchRevision += 1
      detail.value = {
        ...detail.value,
        readSnapshotMessageId: incomingCursor
          ? newerMessageId(detail.value.readSnapshotMessageId, incomingCursor)
          : detail.value.readSnapshotMessageId,
        unreadCount: Math.max(0, payload.conversationUnreadCount)
      }
    }

    applyTotalUnread(payload.totalUnread, version)
  }

  const applyStatusChangedPatch = (payload: InboxConversationStatusChangedPayload): void => {
    if (!payload?.conversationId) return
    const timestamp = Date.parse(payload.time) || 0
    const previousTimestamp = lastStatusTime.get(payload.conversationId) ?? Number.NEGATIVE_INFINITY
    if (timestamp < previousTimestamp) return
    const list = conversations.value.slice()
    const index = list.findIndex((it) => it.conversationId === payload.conversationId)
    if (index >= 0 && timestamp > 0 && timestamp < (Date.parse(list[index]!.updatedAt) || 0)) return
    lastStatusTime.set(payload.conversationId, timestamp)
    if (index >= 0) {
      list[index] = { ...list[index]!, status: payload.status, canReply: payload.status !== 2 }
      conversations.value = list
    }
    if (detail.value && detail.value.conversationId === payload.conversationId) {
      detailPatchRevision += 1
      detail.value = { ...detail.value, status: payload.status, canReply: payload.status !== 2 }
    }
  }

  const consumeInboxPatches = (patches: readonly NotificationStreamInboxRenderPatch[]): void => {
    for (const patch of patches) {
      const payloadTime = typeof patch.payload === 'object' && patch.payload && 'time' in patch.payload
        ? Date.parse(String(patch.payload.time ?? '')) || undefined
        : undefined
      const version: InboxPatchVersion = {
        eventId: patch.eventId,
        time: patch.ts ?? payloadTime
      }
      switch (patch.kind) {
        case 'conversation-upsert':
          applyConversationUpsertPatch(patch.payload as InboxConversationUpsertPayload, version)
          break
        case 'message-append':
          applyMessageAppendPatch(patch.payload as InboxMessageAppendPayload, version)
          break
        case 'read-updated':
          applyReadPatch(patch.payload as InboxReadUpdatedPayload, version)
          break
        case 'conversation-status-changed':
          applyStatusChangedPatch(patch.payload as InboxConversationStatusChangedPayload)
          break
        case 'unread-count':
          if (typeof patch.payload === 'number') {
            applyTotalUnread(patch.payload, version)
          }
          break
        case 'reconnected':
          if (patch.replayMissed) {
            void reconcileAfterReplayMiss()
          } else {
            void refreshList(true, true)
          }
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
      selectionGeneration += 1
      detailRequestController?.abort()
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
    detailRequestController?.abort()
    detailRequestController = null
    detailRequestGeneration += 1
    selectionGeneration += 1
    replayReconcileGeneration += 1
  })

  return {
    loading,
    loadingDetail,
    loadingOlderMessages,
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
    loadOlderMessages,
    selectConversation,
    cancelConversationSwitch,
    saveDraftAndSwitch,
    discardDraftAndSwitch,
    sendReply,
    createTicket
  }
}
