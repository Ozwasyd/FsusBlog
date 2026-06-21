<template>
  <div class="account-page messages-page">
    <header class="account-page-header">
      <h1 class="account-page-title">{{ isAdminView ? '站内信中心' : '我的站内信' }}</h1>
      <p class="account-page-description">
        {{ isAdminView ? '处理账号会话、系统通知与待跟进状态。' : '集中处理站内消息、系统通知与申诉工单。' }}
      </p>
    </header>

    <div class="messages-inbox-layout">
      <MessagesConversationList
        v-if="!isMobile || showListPane"
        ref="conversationListRef"
        v-model:filter="activeFilter"
        :mode="messageMode"
        :is-mobile="isMobile"
        :loading="listLoading"
        :rows="visibleConversationRows"
        :hidden-count="hiddenConversationCount"
        :selected-conversation-id="selectedConversationId"
        :motion-summary="conversationMotion.summary.value"
        :status-label="statusLabel"
        :status-type="statusType"
        :conversation-row-class="conversationRowClass"
        @select="handleSelectConversation"
        @create-ticket="showMobileTicketCompose = true"
        @load-more="conversationRenderLimit += CONVERSATION_RENDER_WINDOW"
      >
        <template #mobile-compose>
          <MessagesComposePanel
            v-if="isMobile && isAdminView"
            v-model:system-target-account-id="systemTargetAccountId"
            v-model:system-subject="systemSubject"
            v-model:system-body="systemBody"
            mode="admin"
            mobile
            :loading="processing"
            @submit="sendSystemMessage"
          />
          <MessagesComposePanel
            v-if="isMobile && !isAdminView && showMobileTicketCompose"
            v-model:create-subject="createSubject"
            v-model:create-body="createBody"
            mode="account"
            mobile
            :loading="creating"
            @submit="handleCreateTicket"
          />
        </template>
      </MessagesConversationList>

      <div v-if="!isMobile || showDetailPane" class="messages-detail-stack">
        <MessagesThreadPanel
          ref="threadPanelRef"
          v-model:reply-body="replyBody"
          :mode="messageMode"
          :is-mobile="isMobile"
          :loading="detailLoading"
          :processing="processing"
          :detail="detail"
          :selection-empty="threadSelectionEmpty"
          :rows="visibleMessageRows"
          :hidden-count="hiddenMessageCount"
          :reply-loading="replyLoading"
          :reply-disabled="replyDisabled"
          :context-account-text="contextAccountText"
          :motion-summary="messageMotion.summary.value"
          :status-label="statusLabel"
          :status-type="statusType"
          @back="handleMobileBackToList"
          @create-ticket="showMobileTicketCompose = true"
          @reply="handleReply"
          @update-status="updateStatus"
          @load-more="messageRenderLimit += MESSAGE_RENDER_WINDOW"
        />

        <MessagesComposePanel
          v-if="!isMobile && isAdminView"
          v-model:system-target-account-id="systemTargetAccountId"
          v-model:system-subject="systemSubject"
          v-model:system-body="systemBody"
          mode="admin"
          :loading="processing"
          @submit="sendSystemMessage"
        />
        <MessagesComposePanel
          v-else-if="!isMobile"
          v-model:create-subject="createSubject"
          v-model:create-body="createBody"
          mode="account"
          :loading="creating"
          @submit="handleCreateTicket"
        />
      </div>
    </div>

    <el-dialog
      :model-value="hasPendingConversationSwitch"
      title="当前回复尚未发送"
      width="min(92vw, 28rem)"
      @close="accountInbox.cancelConversationSwitch"
    >
      <p class="messages-draft-dialog-text">
        当前会话的回复草稿会按会话保留。你可以保存草稿后切换，也可以放弃这段草稿。
      </p>
      <template #footer>
        <el-button @click="accountInbox.cancelConversationSwitch">取消</el-button>
        <el-button @click="handleDiscardDraftAndSwitch">放弃草稿</el-button>
        <el-button type="primary" @click="handleSaveDraftAndSwitch">保存草稿并切换</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="mobileBackConfirmVisible"
      title="回复草稿尚未发送"
      width="min(92vw, 28rem)"
    >
      <p class="messages-draft-dialog-text">
        返回列表后当前回复草稿仍会留在此会话中，但不会发送给对方。
      </p>
      <template #footer>
        <el-button @click="mobileBackConfirmVisible = false">继续回复</el-button>
        <el-button type="primary" @click="confirmMobileBackToList">返回会话列表</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { ConversationFilter } from '@/api/message'
import MessagesComposePanel from '@/components/user/messages/MessagesComposePanel.vue'
import MessagesConversationList from '@/components/user/messages/MessagesConversationList.vue'
import MessagesThreadPanel from '@/components/user/messages/MessagesThreadPanel.vue'
import { useAdminMessageCenter } from '@/composables/useAdminMessageCenter'
import { useInboxSplitView } from '@/composables/useInboxSplitView'
import { useRowStateMotion } from '@/composables/useRowStateMotion'
import { useAccountMessagesInbox } from '@/composables/useAccountMessagesInbox'

type FocusablePane = {
  focusPane: () => void
}

const route = useRoute()
const isAdminView = computed(() => route.name === 'ManageMessages')
const CONVERSATION_RENDER_WINDOW = 80
const MESSAGE_RENDER_WINDOW = 80
const ROW_MOTION_VISIBLE_LIMIT = 20

const adminCenter = useAdminMessageCenter(() => isAdminView.value)
const accountInbox = useAccountMessagesInbox(() => !isAdminView.value)
const conversationMotion = useRowStateMotion({ visibleLimit: ROW_MOTION_VISIBLE_LIMIT })
const messageMotion = useRowStateMotion({ visibleLimit: ROW_MOTION_VISIBLE_LIMIT })
const {
  isHighlighted: isAdminTaskHighlighted
} = adminCenter.taskFeedback
const conversationListRef = ref<FocusablePane | null>(null)
const threadPanelRef = ref<FocusablePane | null>(null)
const showMobileTicketCompose = ref(false)
const mobileBackConfirmVisible = ref(false)
const hasPendingConversationSwitch = computed(() => Boolean(accountInbox.pendingConversationId.value))
const messageMode = computed<'admin' | 'account'>(() => (isAdminView.value ? 'admin' : 'account'))

const selectedConversationId = computed(() =>
  isAdminView.value ? adminCenter.selectedConversationId.value : accountInbox.selectedConversationId.value
)

const {
  isMobile,
  showListPane,
  showDetailPane,
  openListPane,
  openDetailPane
} = useInboxSplitView(selectedConversationId)

const conversations = computed(() =>
  isAdminView.value ? adminCenter.conversations.value : accountInbox.conversations.value
)
const detail = computed(() => (isAdminView.value ? adminCenter.detail.value : accountInbox.detail.value))
const conversationRenderLimit = ref(CONVERSATION_RENDER_WINDOW)
const messageRenderLimit = ref(MESSAGE_RENDER_WINDOW)
const listLoading = computed(() => (isAdminView.value ? adminCenter.loading.value : accountInbox.loading.value))
const detailLoading = computed(() => (isAdminView.value ? adminCenter.loadingDetail.value : accountInbox.loadingDetail.value))
const replyLoading = computed(() => (isAdminView.value ? adminCenter.processing.value : accountInbox.sending.value))
const replyDisabled = computed(() =>
  isAdminView.value
    ? adminCenter.processing.value || !detail.value?.canReply
    : accountInbox.sending.value || !detail.value?.canReply
)
const hasAccountSelection = computed(() => accountInbox.hasSelection.value)
const adminSelectedConversation = computed(() => adminCenter.selectedConversation.value)
const threadSelectionEmpty = computed(() =>
  isAdminView.value ? !adminSelectedConversation.value : !hasAccountSelection.value
)

const activeFilter = computed<ConversationFilter>({
  get: () => (isAdminView.value ? adminCenter.filter.value : accountInbox.filter.value),
  set: (value) => {
    if (isAdminView.value) {
      adminCenter.filter.value = value
      return
    }
    accountInbox.filter.value = value
  }
})

const replyBody = computed({
  get: () => (isAdminView.value ? adminCenter.replyBody.value : accountInbox.replyBody.value),
  set: (value: string) => {
    if (isAdminView.value) {
      adminCenter.replyBody.value = value
      return
    }
    accountInbox.replyBody.value = value
  }
})

const createSubject = computed({
  get: () => accountInbox.createSubject.value,
  set: (value: string) => {
    accountInbox.createSubject.value = value
  }
})

const createBody = computed({
  get: () => accountInbox.createBody.value,
  set: (value: string) => {
    accountInbox.createBody.value = value
  }
})

const systemTargetAccountId = computed({
  get: () => adminCenter.systemTargetAccountId.value,
  set: (value: string) => {
    adminCenter.systemTargetAccountId.value = value
  }
})

const systemSubject = computed({
  get: () => adminCenter.systemSubject.value,
  set: (value: string) => {
    adminCenter.systemSubject.value = value
  }
})

const systemBody = computed({
  get: () => adminCenter.systemBody.value,
  set: (value: string) => {
    adminCenter.systemBody.value = value
  }
})

const creating = computed(() => accountInbox.creating.value)
const processing = computed(() => adminCenter.processing.value)
const isAdminConversationHighlighted = (conversationId: string): boolean =>
  isAdminView.value && isAdminTaskHighlighted(conversationId)
const visibleConversationRows = computed(() => conversations.value.slice(0, conversationRenderLimit.value).map((item) => ({
  ...item,
  lastMessageAtText: formatTime(item.lastMessageAt),
  ariaLabel: conversationAriaLabel(item)
})))
const hiddenConversationCount = computed(() => Math.max(0, conversations.value.length - visibleConversationRows.value.length))
const visibleMessageRows = computed(() => {
  const messages = detail.value?.messages ?? []
  const visible = messages.slice(Math.max(0, messages.length - messageRenderLimit.value))
  return visible.map((message) => ({
    ...message,
    createdAtText: formatTime(message.createdAt),
    senderText: message.senderName || senderLabel(message.senderType),
    bubbleClassName: bubbleClass(message.senderType),
    motionClass: messageMotion.classFor(message.messageId)
  }))
})
const hiddenMessageCount = computed(() => Math.max(0, (detail.value?.messages.length ?? 0) - visibleMessageRows.value.length))
const conversationSignature = computed(() => visibleConversationRows.value
  .map((item) => `${item.conversationId}:${item.status}:${item.unreadCount}:${item.lastMessageAt}`)
  .join('|'))
const messageSignature = computed(() => visibleMessageRows.value
  .map((message) => `${message.messageId}:${message.createdAt}:${message.body}`)
  .join('|'))
const contextAccountText = computed(() => {
  const messages = detail.value?.messages ?? []
  const accountMessage = messages.find((message) => message.senderType === 0 && message.senderName)
  return accountMessage?.senderName || '账号'
})

watch(selectedConversationId, () => {
  messageRenderLimit.value = MESSAGE_RENDER_WINDOW
})

watch(conversations, () => {
  conversationRenderLimit.value = CONVERSATION_RENDER_WINDOW
})

watch(conversationSignature, (_next, previous) => {
  if (!previous) {
    return
  }
  const visibleIds = visibleConversationRows.value
    .slice(0, ROW_MOTION_VISIBLE_LIMIT)
    .map((item) => item.conversationId)
  if (visibleIds.length > 0) {
    conversationMotion.markUpdated(visibleIds, `会话列表已更新：${visibleIds.length} 项`)
  }
})

watch(messageSignature, (_next, previous) => {
  if (!previous) {
    return
  }
  const visibleRows = visibleMessageRows.value
  const latest = visibleRows[visibleRows.length - 1]
  if (latest) {
    messageMotion.markUpdated(latest.messageId, '消息线程已更新')
  }
})

const focusConversationList = async (): Promise<void> => {
  if (!isMobile.value) {
    return
  }
  await nextTick()
  conversationListRef.value?.focusPane()
}

const focusThreadPanel = async (): Promise<void> => {
  if (!isMobile.value) {
    return
  }
  await nextTick()
  threadPanelRef.value?.focusPane()
}

const openListPaneAndFocus = async (): Promise<void> => {
  openListPane()
  await focusConversationList()
}

const openDetailPaneAndFocus = async (): Promise<void> => {
  openDetailPane()
  await focusThreadPanel()
}

const handleSelectConversation = async (conversationId: string): Promise<void> => {
  if (isAdminView.value) {
    openDetailPane()
    await adminCenter.selectConversation(conversationId)
    await focusThreadPanel()
    return
  }

  const switched = await accountInbox.selectConversation(conversationId)
  if (switched) {
    await openDetailPaneAndFocus()
  }
}

const handleCreateTicket = async (): Promise<void> => {
  await accountInbox.createTicket()
  if (accountInbox.selectedConversationId.value) {
    showMobileTicketCompose.value = false
    await openDetailPaneAndFocus()
  }
}

const handleReply = async (): Promise<void> => {
  if (isAdminView.value) {
    await adminCenter.reply()
    return
  }

  await accountInbox.sendReply()
}

const handleMobileBackToList = (): void => {
  if (replyBody.value.trim()) {
    mobileBackConfirmVisible.value = true
    return
  }

  void openListPaneAndFocus()
}

const confirmMobileBackToList = (): void => {
  mobileBackConfirmVisible.value = false
  void openListPaneAndFocus()
}

const updateStatus = async (status: 'open' | 'pending' | 'closed'): Promise<void> => {
  const conversationId = selectedConversationId.value
  if (conversationId) {
    conversationMotion.markPending(conversationId, '正在更新会话状态')
  }
  await adminCenter.updateStatus(status)
  if (conversationId) {
    conversationMotion.markUpdated(conversationId, '会话状态流程已结束')
  }
}

const sendSystemMessage = async (): Promise<void> => {
  await adminCenter.sendSystemMessage()
}

const handleSaveDraftAndSwitch = async (): Promise<void> => {
  if (await accountInbox.saveDraftAndSwitch()) {
    await openDetailPaneAndFocus()
  }
}

const handleDiscardDraftAndSwitch = async (): Promise<void> => {
  if (await accountInbox.discardDraftAndSwitch()) {
    await openDetailPaneAndFocus()
  }
}

const statusLabel = (status: number): string => {
  if (status === 1) return '待处理'
  if (status === 2) return '已关闭'
  return '处理中'
}

const statusType = (status: number): 'warning' | 'success' | '' => {
  if (status === 1) return 'warning'
  if (status === 2) return 'success'
  return ''
}

const conversationAriaLabel = (item: {
  subject: string
  status: number
  unreadCount: number
  isSystemSource: boolean
  lastMessageAt: string
}): string => {
  const parts = [
    item.subject,
    statusLabel(item.status),
    item.isSystemSource ? '系统消息' : '',
    item.unreadCount > 0 ? `${item.unreadCount} 条未读` : '无未读',
    `最后更新 ${formatTime(item.lastMessageAt)}`
  ].filter(Boolean)
  return parts.join('，')
}

const conversationRowClass = (item: { conversationId: string }): string[] => [
  conversationMotion.classFor(item.conversationId),
  item.conversationId === selectedConversationId.value ? 'active' : '',
  isAdminConversationHighlighted(item.conversationId) ? 'blog-motion-row-updated' : ''
].filter(Boolean)

const senderLabel = (senderType: number): string => {
  if (senderType === 1) return '管理员'
  if (senderType === 2) return '系统'
  return isAdminView.value ? '账号' : '我'
}

const bubbleClass = (senderType: number): string => {
  if (senderType === 0) return 'messages-bubble-account'
  if (senderType === 1) return 'messages-bubble-admin'
  return 'messages-bubble-system'
}

const formatTime = (input: string): string => {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
</script>

<style scoped>
@reference "@/assets/main.css";

.messages-page {
  min-height: 100%;
  min-width: 0;
}

.messages-inbox-layout {
  display: grid;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  gap: 3rem;
}

.messages-detail-stack {
  display: flex;
  min-height: 100%;
  min-width: 0;
  max-width: 100%;
  flex-direction: column;
  gap: 4rem;
}

.messages-draft-dialog-text {
  margin: 0;
  color: var(--fsusblog-text-secondary);
  line-height: 1.7;
}

@media (min-width: 1024px) {
  .messages-inbox-layout {
    grid-template-columns: minmax(20rem, 24rem) minmax(0, 1fr);
    gap: 4rem;
    min-height: calc(100dvh - 8rem);
  }
}

@media (max-width: 1023px) {
  .messages-inbox-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 2.5rem;
  }
}
</style>
