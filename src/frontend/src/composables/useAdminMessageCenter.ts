import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import {
  messageApi,
  type ConversationDetailResponse,
  type ConversationFilter,
  type ConversationListItemResponse,
  type ConversationMessagePreviewResponse
} from '@/api/message'
import { useSseStore } from '@/store/sse'
import type { SseInboxRenderPatch } from '@/services/sseTypes'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'

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
  const sseStore = useSseStore()

  const loading = ref(false)
  const loadingDetail = ref(false)
  const processing = ref(false)

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
    try {
      const message = await messageApi.adminReplyConversation(selectedConversationId.value, { body: replyBody.value })
      replyBody.value = ''
      if (detail.value && detail.value.conversationId === selectedConversationId.value) {
        detail.value = {
          ...detail.value,
          messages: [...detail.value.messages, message],
          lastMessageAt: message.createdAt
        }
      }
      const listSynced = await loadConversations(true)
      toast.success('回复已发送')
      if (!listSynced) {
        showWarningToast('回复已发送，但会话列表同步失败，请稍后刷新', '回复已发送，但会话列表同步失败，请稍后刷新')
      }
    } catch (error) {
      showErrorToast(error, '发送回复失败')
    } finally {
      processing.value = false
    }
  }

  const updateStatus = async (status: 'open' | 'pending' | 'closed'): Promise<void> => {
    if (!selectedConversationId.value || processing.value) return
    processing.value = true
    try {
      await messageApi.adminUpdateConversationStatus(selectedConversationId.value, { status })
      const nextStatus = status === 'open' ? 0 : status === 'pending' ? 1 : 2
      if (detail.value && detail.value.conversationId === selectedConversationId.value) {
        detail.value = {
          ...detail.value,
          status: nextStatus
        }
      }
      const currentList = conversations.value.slice()
      const index = currentList.findIndex((it) => it.conversationId === selectedConversationId.value)
      if (index >= 0) {
        currentList[index] = {
          ...currentList[index]!,
          status: nextStatus
        }
        conversations.value = currentList
      }
      const listSynced = await loadConversations(true)
      const detailSynced = await loadDetail(selectedConversationId.value, true)
      toast.success('状态已更新')
      if (!listSynced || !detailSynced) {
        showWarningToast('状态已更新，但列表或详情同步失败，请稍后刷新', '状态已更新，但列表或详情同步失败，请稍后刷新')
      }
    } catch (error) {
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
      toast.success('系统消息已发送')
      if (!listSynced) {
        showWarningToast('系统消息已发送，但会话列表同步失败，请稍后刷新', '系统消息已发送，但会话列表同步失败，请稍后刷新')
      }
    } catch (error) {
      showErrorToast(error, '系统消息发送失败')
    } finally {
      processing.value = false
    }
  }

  const consumePatches = (patches: readonly SseInboxRenderPatch[]): void => {
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
    () => sseStore.inboxRevision,
    () => {
      if (!isEnabled()) {
        return
      }
      consumePatches(sseStore.inboxBatch)
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
