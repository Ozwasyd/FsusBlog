import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import {
  messageApi,
  type ConversationDetailResponse,
  type ConversationFilter,
  type ConversationListItemResponse,
  type ConversationMessagePreviewResponse
} from '@/api/message'
import { useNotificationStreamStore } from '@/store/notificationStream'
import type { NotificationStreamInboxRenderPatch } from '@/services/notificationStreamTypes'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'

const PAGE_SIZE = 30

const toMessagePreview = (message: ConversationDetailResponse['messages'][number]): ConversationMessagePreviewResponse => ({
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

const resetDetailState = (detailRef: { value: ConversationDetailResponse | null }, selectionRef: { value: string }, conversationsRef: { value: ConversationListItemResponse[] }, replyRef: { value: string }) => {
  detailRef.value = null
  selectionRef.value = ''
  conversationsRef.value = []
  replyRef.value = ''
}

export function useAdminMessageCenter(isEnabled: () => boolean = () => true) {
  const notificationStreamStore = useNotificationStreamStore()

  const loading = ref(false)
  const loadingDetail = ref(false)
  const processing = ref(false)
  const taskFeedback = useAdminTaskFeedback()

  const filter = ref<ConversationFilter>('open')
  const conversations = shallowRef<ConversationListItemResponse[]>([])
  const selectedConversationId = ref<string>('')
  const detail = shallowRef<ConversationDetailResponse | null>(null)
  const replyBody = ref('')

  const systemTargetUserId = ref('')
  const systemSubject = ref('')
  const systemBody = ref('')

  const selectedConversation = computed(() =>
    conversations.value.find((it) => it.conversationId === selectedConversationId.value) ?? null
  )

  const loadConversations = async (silent = false): Promise<boolean> => {
    if (!isEnabled()) {
      resetDetailState(detail, selectedConversationId, conversations, replyBody)
      return true
    }

    if (!silent) loading.value = true
    try {
      const data = await messageApi.adminGetConversations(1, PAGE_SIZE, filter.value)
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
      if (!silent) showErrorToast(error, '管理员会话列表加载失败')
      return false
    } finally {
      loading.value = false
    }

    return true
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
    if (!systemTargetUserId.value.trim() || !systemBody.value.trim() || processing.value) return

    const parsedTargetUserId = Number(systemTargetUserId.value.trim())
    if (!Number.isInteger(parsedTargetUserId) || parsedTargetUserId <= 0) {
      showErrorToast('请输入有效的用户 ID', '请输入有效的用户 ID')
      return
    }

    processing.value = true
    taskFeedback.begin('正在发送系统消息', `用户 ${parsedTargetUserId}`, 'admin-system-message')
    try {
      const created = await messageApi.adminSendSystemMessage({
        targetUserId: parsedTargetUserId,
        subject: systemSubject.value || '系统通知',
        body: systemBody.value
      })
      systemTargetUserId.value = ''
      systemSubject.value = ''
      systemBody.value = ''
      const list = conversations.value.slice()
      list.unshift(toConversationListItem(created))
      conversations.value = list
      const listSynced = await loadConversations(true)
      taskFeedback.succeed('系统消息已发送', listSynced ? `用户 ${parsedTargetUserId}` : '列表同步失败，请稍后刷新', 'admin-system-message')
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
    processing,
    filter,
    conversations,
    selectedConversationId,
    selectedConversation,
    detail,
    replyBody,
    systemTargetUserId,
    systemSubject,
    systemBody,
    selectConversation,
    reply,
    updateStatus,
    sendSystemMessage
  }
}
