<template>
  <section class="account-page admin-message-center">
    <header class="account-page-header admin-message-center__header">
      <div>
        <h1 class="account-page-title">站内信中心</h1>
        <p class="account-page-description">
          面向管理员的会话收件箱，用于处理账号消息、状态流转与系统通知。
        </p>
      </div>
    </header>

    <el-inbox-layout
      class="admin-message-center__layout"
      density="compact"
      list-label="管理员会话列表"
      detail-label="管理员会话详情"
      :selected="hasSelectedConversation"
      :mobile-pane="mobilePane"
    >
      <template #list>
        <section
          ref="listPaneRef"
          class="admin-message-center__list"
          tabindex="-1"
          aria-labelledby="admin-message-list-title"
        >
          <header class="admin-message-center__pane-header">
            <div class="admin-message-center__pane-title-group">
              <h2 id="admin-message-list-title" class="admin-message-center__pane-title">管理员收件箱</h2>
              <p class="admin-message-center__pane-description">按处理状态筛选需要跟进的账号会话。</p>
            </div>
            <el-select
              v-model="activeFilter"
              class="admin-message-center__filter"
              name="adminConversationFilter"
              size="small"
              aria-label="筛选管理员会话"
            >
              <el-option
                v-for="option in filterOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </header>

          <div class="admin-message-center__list-body">
            <el-skeleton v-if="listLoading" :rows="8" animated />

            <el-inbox-empty-state
              v-else-if="visibleConversationRows.length === 0"
              title="暂无会话"
              description="当前筛选下没有需要管理员处理的站内信。"
              density="compact"
            />

            <template v-else>
              <p
                v-if="conversationMotionSummary"
                class="blog-motion-summary-enter admin-message-center__motion-summary"
                role="status"
                aria-live="polite"
              >
                {{ conversationMotionSummary }}
              </p>

              <el-conversation-list aria-label="管理员会话列表" density="compact">
                <el-conversation-list-item
                  v-for="item in visibleConversationRows"
                  :key="item.conversationId"
                  :class="item.rowClassName"
                  :title="item.subject"
                  :preview="item.lastMessage?.bodyPreview || '暂无消息内容'"
                  :meta="item.lastMessageAtText"
                  :selected="item.conversationId === selectedConversationId"
                  :unread-count="item.unreadCount"
                  unread-label="条未读消息"
                  density="compact"
                  :aria-label="item.ariaLabel"
                  v-memo="[item.conversationId, item.subject, item.lastMessageAtText, item.unreadCount, item.status, item.rowClassName.join(' ')]"
                  @select="handleSelectConversation(item.conversationId)"
                >
                  <template #badges>
                    <el-tag v-if="item.isSystemSource" size="small">系统</el-tag>
                    <el-tag size="small" :type="statusType(item.status)">{{ statusLabel(item.status) }}</el-tag>
                  </template>
                </el-conversation-list-item>
              </el-conversation-list>

              <el-button
                v-if="hiddenConversationCount > 0"
                class="admin-message-center__load-more"
                link
                type="primary"
                @click="conversationRenderLimit += CONVERSATION_RENDER_WINDOW"
              >
                显示更多会话（{{ hiddenConversationCount }}）
              </el-button>
            </template>
          </div>
        </section>
      </template>

      <template #detail>
        <section
          ref="detailPaneRef"
          class="admin-message-center__detail"
          tabindex="-1"
          aria-live="polite"
          :aria-busy="detailLoading"
        >
          <el-thread-panel
            class="admin-message-center__thread"
            :title="detail?.subject || '请选择会话'"
            title-tag="h2"
            density="compact"
          >
            <template #back>
              <el-button v-if="isMobile" size="small" @click="handleMobileBackToList">
                返回列表
              </el-button>
            </template>

            <template v-if="detail" #status>
              <el-tag v-if="detail.isSystemSource" size="small">系统</el-tag>
              <el-tag size="small" :type="statusType(detail.status)">{{ statusLabel(detail.status) }}</el-tag>
            </template>

            <template v-if="detail" #actions>
              <div class="admin-operator-toolbar" aria-label="管理员会话操作">
                <span class="admin-operator-toolbar__hint">状态变更会通知用户</span>
                <el-button size="small" :disabled="processing" @click="updateStatus('open')">标记为处理中</el-button>
                <el-button size="small" type="warning" :disabled="processing" @click="updateStatus('pending')">移回待处理</el-button>
                <el-button size="small" type="success" :disabled="processing" @click="updateStatus('closed')">关闭会话</el-button>
              </div>
            </template>

            <template v-if="detail" #context>
              <el-conversation-context-bar density="compact">
                <span>正在回复：{{ detail.subject }}</span>
                <span>账号：{{ contextAccountText }}</span>
                <span>最后更新：{{ formatTime(detail.lastMessageAt) }}</span>
              </el-conversation-context-bar>
            </template>

            <template #messages>
              <AdminInlineEmptyState
                v-if="threadSelectionEmpty"
                title="请选择会话"
                description="从左侧管理员收件箱选择一条会话，详情与回复工具会在这里打开。"
              />

              <el-skeleton v-else-if="detailLoading" :rows="10" animated />

              <template v-else>
                <p
                  v-if="messageMotionSummary"
                  class="blog-motion-summary-enter admin-message-center__motion-summary admin-message-center__motion-summary--detail"
                  role="status"
                  aria-live="polite"
                >
                  {{ messageMotionSummary }}
                </p>

                <el-message-timeline
                  v-if="visibleMessageRows.length > 0"
                  aria-label="会话消息时间线"
                  density="compact"
                >
                  <el-message-bubble
                    v-for="message in visibleMessageRows"
                    :key="message.messageId"
                    :class="message.motionClass"
                    :variant="message.bubbleVariant"
                    :author="message.senderText"
                    :meta="message.createdAtText"
                    density="compact"
                    v-memo="[message.messageId, message.body, message.createdAtText, message.motionClass]"
                  >
                    <template #body>
                      <p class="admin-message-center__message-body" data-visual-dynamic>{{ message.body }}</p>
                    </template>
                  </el-message-bubble>
                </el-message-timeline>

                <el-inbox-empty-state
                  v-else
                  title="暂无消息"
                  description="该会话当前没有可展示的消息内容。"
                  density="compact"
                />

                <el-button
                  v-if="hiddenMessageCount > 0"
                  class="admin-message-center__load-more admin-message-center__load-more--messages"
                  link
                  type="primary"
                  @click="messageRenderLimit += MESSAGE_RENDER_WINDOW"
                >
                  显示更早消息（{{ hiddenMessageCount }}）
                </el-button>
              </template>
            </template>

            <template v-if="detail" #composer>
              <el-reply-composer-shell
                title="回复当前会话"
                :disabled="replyDisabled"
                density="compact"
              >
                <template #input>
                  <el-input
                    v-model="replyBody"
                    name="adminConversationReply"
                    type="textarea"
                    :rows="4"
                    maxlength="4000"
                    show-word-limit
                    :disabled="replyDisabled"
                    placeholder="请输入给账号的回复内容"
                  />
                </template>
                <template #actions>
                  <el-button
                    type="primary"
                    :loading="processing"
                    :disabled="replyDisabled || !replyBody.trim()"
                    @click="handleReply"
                  >
                    发送回复
                  </el-button>
                </template>
              </el-reply-composer-shell>
            </template>
          </el-thread-panel>
        </section>
      </template>
    </el-inbox-layout>

    <section class="admin-message-center__system-panel" aria-labelledby="admin-system-message-title">
      <el-reply-composer-shell
        id="admin-system-message-title"
        title="发送系统消息"
        :disabled="processing"
        density="compact"
      >
        <template #input>
          <el-form class="admin-message-center__system-form" label-position="top">
            <el-form-item label="目标账号 ID">
              <el-input
                v-model="systemTargetAccountId"
                name="adminSystemTargetAccountId"
                placeholder="请输入账号 ID"
              />
            </el-form-item>
            <el-form-item label="主题">
              <el-input
                v-model="systemSubject"
                name="adminSystemSubject"
                maxlength="160"
                show-word-limit
                placeholder="例如：系统通知"
              />
            </el-form-item>
            <el-form-item class="admin-message-center__system-form-body" label="内容">
              <el-input
                v-model="systemBody"
                name="adminSystemBody"
                type="textarea"
                :rows="4"
                maxlength="4000"
                show-word-limit
                placeholder="请输入消息正文"
              />
            </el-form-item>
          </el-form>
        </template>
        <template #actions>
          <el-button type="success" :loading="processing" @click="sendSystemMessage">
            发送系统消息
          </el-button>
        </template>
      </el-reply-composer-shell>
    </section>

    <el-dialog
      v-model="mobileBackConfirmVisible"
      title="回复草稿尚未发送"
      width="min(92vw, 28rem)"
    >
      <p class="admin-message-center__dialog-text">
        返回列表后当前回复草稿仍会留在此会话中，但不会发送给对方。
      </p>
      <template #footer>
        <el-button @click="mobileBackConfirmVisible = false">继续回复</el-button>
        <el-button type="primary" @click="confirmMobileBackToList">返回会话列表</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type {
  ConversationFilter,
  ConversationListItemResponse,
  ConversationMessageResponse,
  ConversationStatus
} from '@/api/message'
import { useAdminMessageCenter } from '@/composables/useAdminMessageCenter'
import { useInboxSplitView } from '@/composables/useInboxSplitView'
import { useRowStateMotion } from '@/composables/useRowStateMotion'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'

type MessageBubbleVariant = 'self' | 'other' | 'system' | 'muted'

type ConversationRow = ConversationListItemResponse & {
  lastMessageAtText: string
  ariaLabel: string
  rowClassName: string[]
}

type MessageRow = ConversationMessageResponse & {
  createdAtText: string
  senderText: string
  bubbleVariant: MessageBubbleVariant
  motionClass: string
}

const CONVERSATION_RENDER_WINDOW = 80
const MESSAGE_RENDER_WINDOW = 80
const ROW_MOTION_VISIBLE_LIMIT = 20

const adminCenter = useAdminMessageCenter()
const conversationMotion = useRowStateMotion({ visibleLimit: ROW_MOTION_VISIBLE_LIMIT })
const messageMotion = useRowStateMotion({ visibleLimit: ROW_MOTION_VISIBLE_LIMIT })
const {
  isHighlighted: isAdminTaskHighlighted
} = adminCenter.taskFeedback

const selectedConversationId = computed(() => adminCenter.selectedConversationId.value)
const selectedConversation = computed(() => adminCenter.selectedConversation.value)
const hasSelectedConversation = computed(() => Boolean(selectedConversationId.value))
const {
  isMobile,
  mobilePane,
  openListPane,
  openDetailPane
} = useInboxSplitView(selectedConversationId)

const listPaneRef = ref<HTMLElement | null>(null)
const detailPaneRef = ref<HTMLElement | null>(null)
const mobileBackConfirmVisible = ref(false)
const conversationRenderLimit = ref(CONVERSATION_RENDER_WINDOW)
const messageRenderLimit = ref(MESSAGE_RENDER_WINDOW)

const listLoading = computed(() => adminCenter.loading.value)
const detailLoading = computed(() => adminCenter.loadingDetail.value)
const processing = computed(() => adminCenter.processing.value)
const detail = computed(() => adminCenter.detail.value)
const threadSelectionEmpty = computed(() => !selectedConversation.value)
const replyDisabled = computed(() => adminCenter.processing.value || !detail.value?.canReply)
const conversationMotionSummary = computed(() => conversationMotion.summary.value)
const messageMotionSummary = computed(() => messageMotion.summary.value)

const filterOptions = [
  { label: '处理中', value: 'open' },
  { label: '待处理', value: 'pending' },
  { label: '已关闭', value: 'closed' },
  { label: '系统', value: 'system' },
  { label: '全部', value: 'all' }
] satisfies { label: string; value: ConversationFilter }[]

const activeFilter = computed<ConversationFilter>({
  get: () => adminCenter.filter.value,
  set: (value) => {
    adminCenter.filter.value = value
  }
})

const replyBody = computed({
  get: () => adminCenter.replyBody.value,
  set: (value: string) => {
    adminCenter.replyBody.value = value
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

const visibleConversationRows = computed<ConversationRow[]>(() =>
  adminCenter.conversations.value.slice(0, conversationRenderLimit.value).map((item) => ({
    ...item,
    lastMessageAtText: formatTime(item.lastMessageAt),
    ariaLabel: conversationAriaLabel(item),
    rowClassName: conversationRowClass(item)
  }))
)
const hiddenConversationCount = computed(() =>
  Math.max(0, adminCenter.conversations.value.length - visibleConversationRows.value.length)
)
const visibleMessageRows = computed<MessageRow[]>(() => {
  const messages = detail.value?.messages ?? []
  const visible = messages.slice(Math.max(0, messages.length - messageRenderLimit.value))
  return visible.map((message) => ({
    ...message,
    createdAtText: formatTime(message.createdAt),
    senderText: message.senderName || senderLabel(message.senderType),
    bubbleVariant: messageBubbleVariant(message.senderType),
    motionClass: messageMotion.classFor(message.messageId)
  }))
})
const hiddenMessageCount = computed(() =>
  Math.max(0, (detail.value?.messages.length ?? 0) - visibleMessageRows.value.length)
)
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

watch(() => adminCenter.conversations.value, () => {
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
    conversationMotion.markUpdated(visibleIds, `管理员收件箱已更新：${visibleIds.length} 项`)
  }
})

watch(messageSignature, (_next, previous) => {
  if (!previous) {
    return
  }
  const latest = visibleMessageRows.value[visibleMessageRows.value.length - 1]
  if (latest) {
    messageMotion.markUpdated(latest.messageId, '管理员会话线程已更新')
  }
})

const focusListPane = async (): Promise<void> => {
  if (!isMobile.value) {
    return
  }
  await nextTick()
  listPaneRef.value?.focus()
}

const focusDetailPane = async (): Promise<void> => {
  if (!isMobile.value) {
    return
  }
  await nextTick()
  detailPaneRef.value?.focus()
}

const openListPaneAndFocus = async (): Promise<void> => {
  openListPane()
  await focusListPane()
}

const handleSelectConversation = async (conversationId: string): Promise<void> => {
  openDetailPane()
  await adminCenter.selectConversation(conversationId)
  await focusDetailPane()
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

const handleReply = async (): Promise<void> => {
  await adminCenter.reply()
}

const updateStatus = async (status: ConversationStatus): Promise<void> => {
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

const senderLabel = (senderType: number): string => {
  if (senderType === 1) return '管理员'
  if (senderType === 2) return '系统'
  return '账号'
}

const messageBubbleVariant = (senderType: number): MessageBubbleVariant => {
  if (senderType === 1) return 'self'
  if (senderType === 2) return 'system'
  return 'other'
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
  isAdminTaskHighlighted(item.conversationId) ? 'blog-motion-row-updated' : ''
].filter(Boolean)

const formatTime = (input: string): string => {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
</script>

<style scoped>
@reference "@/assets/main.css";

.admin-message-center {
  min-width: 0;
}

.admin-message-center__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.admin-message-center__layout {
  min-height: calc(100dvh - 15rem);
}

.admin-message-center__list,
.admin-message-center__detail {
  min-width: 0;
  min-height: 100%;
  outline: none;
}

.admin-message-center__list:focus-visible,
.admin-message-center__detail:focus-visible {
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
}

.admin-message-center__pane-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  padding: 1rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
}

.admin-message-center__pane-title-group {
  min-width: 0;
}

.admin-message-center__pane-title {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 1rem;
  font-weight: 800;
  line-height: 1.35;
  letter-spacing: 0;
}

.admin-message-center__pane-description {
  margin: 0.35rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.75rem;
  line-height: 1.6;
}

.admin-message-center__filter {
  width: 9rem;
  flex: 0 0 auto;
}

.admin-message-center__list-body {
  min-width: 0;
}

.admin-message-center__motion-summary {
  margin: 0;
  padding: 0.75rem 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.75rem;
  font-weight: 700;
}

.admin-message-center__motion-summary--detail {
  padding-bottom: 0;
}

.admin-message-center__load-more {
  margin: 0.75rem 1rem 1rem;
}

.admin-message-center__load-more--messages {
  margin-top: 0;
}

.admin-operator-toolbar {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  min-width: 0;
}

.admin-operator-toolbar__hint {
  align-self: center;
  color: var(--fsusblog-text-muted);
  font-size: 0.6875rem;
  font-weight: 800;
  line-height: 1.5;
}

.admin-message-center__message-body {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.admin-message-center__system-panel {
  margin-top: 2rem;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
}

.admin-message-center__system-form {
  display: grid;
  grid-template-columns: minmax(9rem, 0.3fr) minmax(12rem, 0.7fr);
  gap: 0.75rem 1rem;
}

.admin-message-center__system-form-body {
  grid-column: 1 / -1;
}

.admin-message-center__dialog-text {
  margin: 0;
  color: var(--fsusblog-text-secondary);
  line-height: 1.7;
}

@media (max-width: 760px) {
  .admin-message-center__layout {
    min-height: 28rem;
  }

  .admin-message-center__pane-header,
  .admin-message-center__system-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .admin-message-center__filter {
    width: 100%;
  }

  .admin-operator-toolbar {
    justify-content: flex-start;
  }
}
</style>
