import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import {
  messageApi,
  type AdminConversationDetailResponse,
  type AdminConversationListItemResponse,
  type ConversationFilter,
} from '@/api/message'
import { useNotificationStreamStore } from '@/store/notificationStream'
import type { NotificationStreamInboxRenderPatch } from '@/services/notificationStreamTypes'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'
import { mergeConversationPages } from '@/composables/messageConversationPagination'
import { mergeConversationMessagePages } from '@/composables/messageThreadPagination'

const PAGE_SIZE = 30

const resetDetailState = (detailRef: { value: AdminConversationDetailResponse | null }, selectionRef: { value: string }, conversationsRef: { value: AdminConversationListItemResponse[] }, replyRef: { value: string }) => {
  detailRef.value = null
  selectionRef.value = ''
  conversationsRef.value = []
  replyRef.value = ''
}

export function useAdminMessageCenter(isEnabled: () => boolean = () => true) {
  const notificationStreamStore = useNotificationStreamStore()

  const loading = ref(false)
  const loadingDetail = ref(false)
  const loadingOlderMessages = ref(false)
  const processing = ref(false)
  const taskFeedback = useAdminTaskFeedback()

  const filter = ref<ConversationFilter>('open')
  const conversations = shallowRef<AdminConversationListItemResponse[]>([])
  const totalConversations = ref(0)
  const nextCursor = ref<string | null>(null)
  const hasMoreConversations = ref(false)
  const loadingMoreConversations = ref(false)
  const loadedPageCount = ref(0)
  const selectedConversationId = ref<string>('')
  const detail = shallowRef<AdminConversationDetailResponse | null>(null)
  const replyBody = ref('')

  const systemTargetAccountId = ref('')
  const systemSubject = ref('')
  const systemBody = ref('')

  const selectedConversation = computed(() =>
    conversations.value.find((it) => it.conversationId === selectedConversationId.value) ?? null
  )

  const resetPagination = (): void => {
    totalConversations.value = 0
    nextCursor.value = null
    hasMoreConversations.value = false
    loadedPageCount.value = 0
  }

  const loadConversations = async (silent = false, preserveLoaded = silent): Promise<boolean> => {
    if (!isEnabled()) {
      resetDetailState(detail, selectedConversationId, conversations, replyBody)
      resetPagination()
      return true
    }

    if (!silent) loading.value = true
    try {
      const data = await messageApi.adminGetConversations(PAGE_SIZE, filter.value)
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
    } catch (error) {
      if (!silent) showErrorToast(error, '管理员会话列表加载失败')
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
      const data = await messageApi.adminGetConversations(PAGE_SIZE, filter.value, nextCursor.value)
      conversations.value = mergeConversationPages(conversations.value, data.items || [])
      totalConversations.value = data.total
      nextCursor.value = data.nextCursor ?? null
      hasMoreConversations.value = Boolean(data.hasMore && data.nextCursor)
      loadedPageCount.value += 1
      return true
    } catch (error) {
      showErrorToast(error, '更多管理员会话加载失败')
      return false
    } finally {
      loadingMoreConversations.value = false
    }
  }

  const loadDetail = async (conversationId: string, silent = false): Promise<boolean> => {
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
      detail.value = await messageApi.adminGetConversationDetail(conversationId)
    } catch (error) {
      if (!silent) {
        showErrorToast(error, '会话详情加载失败')
      }
      return false
    } finally {
      loadingDetail.value = false
    }

    return true
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
      const older = await messageApi.adminGetConversationDetail(conversationId, cursor)
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

  const selectConversation = async (conversationId: string): Promise<void> => {
    selectedConversationId.value = conversationId
    await loadDetail(conversationId)
  }

  const reply = async (): Promise<void> => {
    if (!selectedConversationId.value || !replyBody.value.trim() || processing.value) return
    processing.value = true
    const conversationId = selectedConversationId.value
    taskFeedback.begin('正在发送站内信回复', conversationId, conversationId)
    try {
      const message = await messageApi.adminReplyConversation(conversationId, { body: replyBody.value })
      replyBody.value = ''
      if (detail.value && detail.value.conversationId === conversationId) {
        detail.value = {
          ...detail.value,
          messages: [...detail.value.messages, message],
          lastMessageAt: message.createdAt
        }
      }
      const listSynced = await loadConversations(true)
      taskFeedback.succeed('站内信回复已发送', listSynced ? conversationId : '列表同步失败，请稍后刷新', conversationId)
      toast.success('回复已发送')
      if (!listSynced) {
        showWarningToast('回复已发送，但会话列表同步失败，请稍后刷新', '回复已发送，但会话列表同步失败，请稍后刷新')
      }
    } catch (error) {
      taskFeedback.fail('发送回复失败', error, '发送回复失败', conversationId)
      showErrorToast(error, '发送回复失败')
    } finally {
      processing.value = false
    }
  }

  const updateStatus = async (status: 'open' | 'pending' | 'closed'): Promise<void> => {
    if (!selectedConversationId.value || processing.value) return
    processing.value = true
    const conversationId = selectedConversationId.value
    taskFeedback.begin('正在更新会话状态', `${conversationId} -> ${status}`, conversationId)
    try {
      await messageApi.adminUpdateConversationStatus(conversationId, { status })
      const nextStatus = status === 'open' ? 0 : status === 'pending' ? 1 : 2
      if (detail.value && detail.value.conversationId === conversationId) {
        detail.value = {
          ...detail.value,
          status: nextStatus
        }
      }
      const currentList = conversations.value.slice()
      const index = currentList.findIndex((it) => it.conversationId === conversationId)
      if (index >= 0) {
        currentList[index] = {
          ...currentList[index]!,
          status: nextStatus
        }
        conversations.value = currentList
      }
      const listSynced = await loadConversations(true)
      const detailSynced = await loadDetail(conversationId, true)
      if (listSynced && detailSynced) {
        taskFeedback.succeed('会话状态已更新', `${conversationId} -> ${status}`, conversationId)
      } else {
        taskFeedback.partial('会话状态已更新', '列表或详情同步失败，请稍后刷新', conversationId)
      }
      toast.success('状态已更新')
      if (!listSynced || !detailSynced) {
        showWarningToast('状态已更新，但列表或详情同步失败，请稍后刷新', '状态已更新，但列表或详情同步失败，请稍后刷新')
      }
    } catch (error) {
      taskFeedback.fail('状态更新失败', error, '状态更新失败', conversationId)
      showErrorToast(error, '状态更新失败')
    } finally {
      processing.value = false
    }
  }

  const sendSystemMessage = async (): Promise<void> => {
    if (!systemTargetAccountId.value.trim() || !systemBody.value.trim() || processing.value) return

    const parsedTargetAccountId = Number(systemTargetAccountId.value.trim())
    if (!Number.isInteger(parsedTargetAccountId) || parsedTargetAccountId <= 0) {
      showErrorToast('请输入有效的账号 ID', '请输入有效的账号 ID')
      return
    }

    processing.value = true
    taskFeedback.begin('正在发送系统消息', `账号 ${parsedTargetAccountId}`, 'admin-system-message')
    try {
      await messageApi.adminSendSystemMessage({
        targetAccountId: parsedTargetAccountId,
        subject: systemSubject.value || '系统通知',
        body: systemBody.value
      })
      systemTargetAccountId.value = ''
      systemSubject.value = ''
      systemBody.value = ''
      const listSynced = await loadConversations(true)
      taskFeedback.succeed('系统消息已发送', listSynced ? `账号 ${parsedTargetAccountId}` : '列表同步失败，请稍后刷新', 'admin-system-message')
      toast.success('系统消息已发送')
      if (!listSynced) {
        showWarningToast('系统消息已发送，但会话列表同步失败，请稍后刷新', '系统消息已发送，但会话列表同步失败，请稍后刷新')
      }
    } catch (error) {
      taskFeedback.fail('系统消息发送失败', error, '系统消息发送失败', 'admin-system-message')
      showErrorToast(error, '系统消息发送失败')
    } finally {
      processing.value = false
    }
  }

  const consumePatches = (patches: readonly NotificationStreamInboxRenderPatch[]): void => {
    let requiresRefresh = false
    for (const patch of patches) {
      if (patch.kind === 'conversation-upsert' || patch.kind === 'message-append' || patch.kind === 'conversation-closed') {
        requiresRefresh = true
      }
    }

    if (requiresRefresh) {
      void loadConversations(true)
      if (selectedConversationId.value) {
        void loadDetail(selectedConversationId.value)
      }
    }
  }

  watch(
    () => filter.value,
    () => {
      if (!isEnabled()) {
        return
      }
      void loadConversations()
    }
  )

  watch(
    () => notificationStreamStore.inboxRevision,
    () => {
      if (!isEnabled()) {
        return
      }
      consumePatches(notificationStreamStore.inboxBatch)
    }
  )

  watch(
    () => isEnabled(),
    (enabled) => {
      if (enabled) {
        void loadConversations()
        return
      }

      resetDetailState(detail, selectedConversationId, conversations, replyBody)
      resetPagination()
    }
  )

  onMounted(async () => {
    if (!isEnabled()) {
      return
    }

    await loadConversations()
    if (selectedConversationId.value) {
      await loadDetail(selectedConversationId.value)
    }
  })

  return {
    taskFeedback,
    loading,
    loadingDetail,
    loadingOlderMessages,
    processing,
    filter,
    conversations,
    totalConversations,
    hasMoreConversations,
    loadingMoreConversations,
    selectedConversationId,
    selectedConversation,
    detail,
    replyBody,
    systemTargetAccountId,
    systemSubject,
    systemBody,
    selectConversation,
    loadMoreConversations,
    loadOlderMessages,
    reply,
    updateStatus,
    sendSystemMessage
  }
}
