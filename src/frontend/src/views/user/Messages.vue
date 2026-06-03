<template>
  <div class="account-page mail-page">
      <header class="account-page-header">
        <div class="account-page-eyebrow">{{ isAdminView ? '管理' : '消息' }}</div>
        <h1 class="account-page-title">{{ isAdminView ? '站内信中心' : '我的站内信' }}</h1>
        <p class="account-page-description">
          {{ isAdminView ? '在一个双栏工作台里处理用户会话、系统通知与状态流转。' : '集中处理站内消息、系统通知与申诉工单，保持账户区统一的阅读节奏。' }}
        </p>
      </header>

    <div class="mail-layout">
      <section v-show="showListPane" class="mail-pane mail-list-pane">
        <div class="mail-flat-pane">
          <header class="mail-pane-header">
            <div class="mail-header">
              <div>
                <div class="mail-header-eyebrow">会话目录</div>
                <div class="mail-header-title">{{ isAdminView ? '处理中会话' : '消息列表' }}</div>
              </div>
              <div class="mail-filter">
                <el-select v-if="isAdminView" v-model="adminFilter" name="adminConversationFilter" size="small">
                  <el-option label="处理中" value="open" />
                  <el-option label="待处理" value="pending" />
                  <el-option label="已关闭" value="closed" />
                  <el-option label="系统" value="system" />
                  <el-option label="全部" value="all" />
                </el-select>
                <el-select v-else v-model="userFilter" name="userConversationFilter" size="small">
                  <el-option label="全部" value="all" />
                  <el-option label="未读" value="unread" />
                  <el-option label="系统消息" value="system" />
                  <el-option label="处理中" value="open" />
                  <el-option label="待处理" value="pending" />
                  <el-option label="已关闭" value="closed" />
                </el-select>
              </div>
            </div>
          </header>

          <div class="mail-pane-body">
            <div v-if="isMobile && !isAdminView" class="mail-mobile-primary">
              <el-button type="primary" @click="showMobileTicketCompose = !showMobileTicketCompose">
                新建工单
              </el-button>
            </div>

            <el-skeleton v-if="listLoading" :rows="8" animated />

            <div v-else-if="conversations.length === 0" class="mail-empty">
              <el-empty description="暂无会话" />
            </div>

            <div v-else class="mail-scroll-region">
              <div class="mail-scroll-frame">
                <el-scrollbar class="mail-scrollbar">
                  <ul class="mail-item-stack" aria-label="会话列表">
                    <li
                      v-for="item in conversations"
                      :key="item.conversationId"
                      class="mail-item-entry"
                    >
                    <button
                      type="button"
                      class="mail-item"
                      :class="{ active: item.conversationId === selectedConversationId }"
                      :aria-current="item.conversationId === selectedConversationId ? 'true' : undefined"
                      :aria-pressed="item.conversationId === selectedConversationId"
                      :aria-label="conversationAriaLabel(item)"
                      @click="handleSelectConversation(item.conversationId)"
                    >
                      <div class="mail-item-top">
                        <span class="mail-item-subject" data-visual-dynamic>{{ item.subject }}</span>
                        <div class="mail-item-top-right">
                          <el-tag v-if="item.isSystemSource" size="small">系统</el-tag>
                          <el-tag size="small" :type="statusType(item.status)">{{ statusLabel(item.status) }}</el-tag>
                        </div>
                      </div>
                      <p class="mail-item-preview" data-visual-dynamic>{{ item.lastMessage?.bodyPreview || (isAdminView ? '暂无内容' : '暂无消息内容') }}</p>
                      <div class="mail-item-meta">
                        <time :datetime="item.lastMessageAt" data-visual-dynamic>{{ formatTime(item.lastMessageAt) }}</time>
                        <el-badge v-if="item.unreadCount > 0" :value="item.unreadCount" />
                      </div>
                    </button>
                    </li>
                  </ul>
                </el-scrollbar>
              </div>
            </div>

            <div v-if="isMobile && isAdminView" class="mail-mobile-compose">
              <div class="mail-subheader">发送系统消息</div>
              <el-form label-position="top">
                <el-form-item label="目标用户 ID">
                  <el-input v-model="systemTargetUserId" name="systemTargetUserIdMobile" placeholder="请输入用户 ID" />
                </el-form-item>
                <el-form-item label="主题">
                  <el-input v-model="systemSubject" name="systemSubjectMobile" maxlength="160" show-word-limit placeholder="例如：系统通知" />
                </el-form-item>
                <el-form-item label="内容">
                  <el-input v-model="systemBody" name="systemBodyMobile" type="textarea" :rows="4" maxlength="4000" show-word-limit placeholder="请输入消息正文" />
                </el-form-item>
                <el-button type="success" :loading="processing" @click="sendSystemMessage">发送</el-button>
              </el-form>
            </div>

            <div v-if="isMobile && !isAdminView && showMobileTicketCompose" class="mail-mobile-compose">
              <div class="mail-subheader">新建申诉工单</div>
              <el-form label-position="top">
                <el-form-item label="主题">
                  <el-input v-model="createSubject" name="ticketSubjectMobile" maxlength="160" show-word-limit placeholder="例如：账号误封申诉" />
                </el-form-item>
                <el-form-item label="内容">
                  <el-input v-model="createBody" name="ticketBodyMobile" type="textarea" :rows="4" maxlength="4000" show-word-limit placeholder="请描述问题与诉求" />
                </el-form-item>
                <el-button type="success" :loading="creating" @click="handleCreateTicket">提交工单</el-button>
              </el-form>
            </div>
          </div>
        </div>
      </section>

      <section v-show="showDetailPane" class="mail-pane mail-detail-pane mail-detail-stack mail-thread-panel" aria-live="polite" :aria-busy="detailLoading">
        <div class="mail-flat-pane mail-thread-flat-pane">
          <header class="mail-pane-header mail-pane-header-detail">
            <div class="mail-header mail-header-detail">
              <div class="mail-detail-title-group">
                <el-button v-if="isMobile" size="small" @click="openListPane">
                  返回会话列表
                </el-button>
                <div class="mail-header-title-row">
                  <span class="mail-header-title" data-visual-dynamic>{{ detail?.subject || '请选择会话' }}</span>
                  <div class="mail-item-top-right" v-if="detail">
                    <el-tag v-if="detail.isSystemSource" size="small">系统</el-tag>
                    <el-tag size="small" :type="statusType(detail.status)">{{ statusLabel(detail.status) }}</el-tag>
                  </div>
                </div>
              </div>

              <div v-if="isAdminView && detail" class="mail-actions">
                <el-button size="small" @click="updateStatus('open')" :disabled="processing">处理中</el-button>
                <el-button size="small" type="warning" @click="updateStatus('pending')" :disabled="processing">待处理</el-button>
                <el-button size="small" type="success" @click="updateStatus('closed')" :disabled="processing">关闭</el-button>
              </div>
            </div>
          </header>

          <div class="mail-pane-body mail-thread-body">
            <div
              v-if="isAdminView ? !adminSelectedConversation : !hasUserSelection"
              class="mail-empty"
            >
              <el-empty :description="isAdminView ? '请选择会话' : '从左侧选择会话或创建新工单'" />
            </div>

            <el-skeleton v-else-if="detailLoading" :rows="10" animated />

            <template v-else>
              <div class="mail-scroll-region mail-thread-region">
                <div class="mail-scroll-frame">
                <el-scrollbar class="mail-scrollbar">
                    <div
                      v-for="msg in detail?.messages || []"
                      :key="msg.messageId"
                      class="mail-bubble"
                      :class="bubbleClass(msg.senderType)"
                    >
                      <div class="mail-bubble-meta">
                        <span data-visual-dynamic>{{ msg.senderName || senderLabel(msg.senderType) }}</span>
                        <time :datetime="msg.createdAt" data-visual-dynamic>{{ formatTime(msg.createdAt) }}</time>
                      </div>
                      <p class="mail-bubble-body" data-visual-dynamic>{{ msg.body }}</p>
                    </div>
                  </el-scrollbar>
                </div>
              </div>

              <el-divider />

              <div class="mail-reply-form">
                <el-form label-position="top">
                  <el-form-item :label="isAdminView ? '回复' : '回复管理员'">
                    <el-input
                      v-model="replyBody"
                      name="conversationReply"
                      type="textarea"
                      :rows="4"
                      maxlength="4000"
                      show-word-limit
                      :disabled="replyDisabled"
                      placeholder="请输入回复内容"
                    />
                  </el-form-item>
                  <el-button type="primary" :loading="replyLoading" :disabled="replyDisabled || !replyBody.trim()" @click="handleReply">
                    发送回复
                  </el-button>
                </el-form>
              </div>
            </template>
          </div>
        </div>

        <div v-if="!isMobile && isAdminView" class="mail-flat-pane mail-compose-panel">
          <header class="mail-pane-header">
            <span class="mail-header-title">发送系统消息</span>
          </header>
          <div class="mail-pane-body">
            <el-form label-position="top">
              <el-form-item label="目标用户 ID">
                <el-input v-model="systemTargetUserId" name="systemTargetUserIdDesktop" placeholder="请输入用户 ID" />
              </el-form-item>
              <el-form-item label="主题">
                <el-input v-model="systemSubject" name="systemSubjectDesktop" maxlength="160" show-word-limit placeholder="例如：系统通知" />
              </el-form-item>
              <el-form-item label="内容">
                <el-input v-model="systemBody" name="systemBodyDesktop" type="textarea" :rows="4" maxlength="4000" show-word-limit placeholder="请输入消息正文" />
              </el-form-item>
              <el-button type="success" :loading="processing" @click="sendSystemMessage">发送</el-button>
            </el-form>
          </div>
        </div>

        <div v-else-if="!isMobile" class="mail-flat-pane mail-compose-panel">
          <header class="mail-pane-header">
            <span class="mail-header-title">新建申诉工单</span>
          </header>
          <div class="mail-pane-body">
            <el-form label-position="top">
              <el-form-item label="主题">
                <el-input v-model="createSubject" name="ticketSubjectDesktop" maxlength="160" show-word-limit placeholder="例如：账号误封申诉" />
              </el-form-item>
              <el-form-item label="内容">
                <el-input v-model="createBody" name="ticketBodyDesktop" type="textarea" :rows="4" maxlength="4000" show-word-limit placeholder="请描述问题与诉求" />
              </el-form-item>
              <el-button type="success" :loading="creating" @click="handleCreateTicket">提交工单</el-button>
            </el-form>
          </div>
        </div>
      </section>
    </div>

    <el-dialog
      :model-value="hasPendingConversationSwitch"
      title="当前回复尚未发送"
      width="min(92vw, 28rem)"
      @close="userInbox.cancelConversationSwitch"
    >
      <p class="mail-draft-dialog-text">
        当前会话的回复草稿会按会话保留。你可以保存草稿后切换，也可以放弃这段草稿。
      </p>
      <template #footer>
        <el-button @click="userInbox.cancelConversationSwitch">取消</el-button>
        <el-button @click="handleDiscardDraftAndSwitch">放弃草稿</el-button>
        <el-button type="primary" @click="handleSaveDraftAndSwitch">保存草稿并切换</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useAdminMessageCenter } from '@/composables/useAdminMessageCenter'
import { useInboxSplitView } from '@/composables/useInboxSplitView'
import { useUserMessagesInbox } from '@/composables/useUserMessagesInbox'

const route = useRoute()
const isAdminView = computed(() => route.name === 'ManageMessages')

const adminCenter = useAdminMessageCenter(() => isAdminView.value)
const userInbox = useUserMessagesInbox(() => !isAdminView.value)
const showMobileTicketCompose = ref(false)
const hasPendingConversationSwitch = computed(() => Boolean(userInbox.pendingConversationId.value))

const selectedConversationId = computed(() =>
  isAdminView.value ? adminCenter.selectedConversationId.value : userInbox.selectedConversationId.value
)

const {
  isMobile,
  showListPane,
  showDetailPane,
  openListPane,
  openDetailPane
} = useInboxSplitView(selectedConversationId)

const conversations = computed(() =>
  isAdminView.value ? adminCenter.conversations.value : userInbox.conversations.value
)
const detail = computed(() => (isAdminView.value ? adminCenter.detail.value : userInbox.detail.value))
const listLoading = computed(() => (isAdminView.value ? adminCenter.loading.value : userInbox.loading.value))
const detailLoading = computed(() => (isAdminView.value ? adminCenter.loadingDetail.value : userInbox.loadingDetail.value))
const replyLoading = computed(() => (isAdminView.value ? adminCenter.processing.value : userInbox.sending.value))
const replyDisabled = computed(() =>
  isAdminView.value
    ? adminCenter.processing.value || !detail.value?.canReply
    : userInbox.sending.value || !detail.value?.canReply
)
const hasUserSelection = computed(() => userInbox.hasSelection.value)
const adminSelectedConversation = computed(() => adminCenter.selectedConversation.value)

const adminFilter = computed({
  get: () => adminCenter.filter.value,
  set: (value) => {
    adminCenter.filter.value = value
  }
})

const userFilter = computed({
  get: () => userInbox.filter.value,
  set: (value) => {
    userInbox.filter.value = value
  }
})

const replyBody = computed({
  get: () => (isAdminView.value ? adminCenter.replyBody.value : userInbox.replyBody.value),
  set: (value: string) => {
    if (isAdminView.value) {
      adminCenter.replyBody.value = value
      return
    }
    userInbox.replyBody.value = value
  }
})

const createSubject = computed({
  get: () => userInbox.createSubject.value,
  set: (value: string) => {
    userInbox.createSubject.value = value
  }
})

const createBody = computed({
  get: () => userInbox.createBody.value,
  set: (value: string) => {
    userInbox.createBody.value = value
  }
})

const systemTargetUserId = computed({
  get: () => adminCenter.systemTargetUserId.value,
  set: (value: string) => {
    adminCenter.systemTargetUserId.value = value
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

const creating = computed(() => userInbox.creating.value)
const processing = computed(() => adminCenter.processing.value)

const handleSelectConversation = async (conversationId: string): Promise<void> => {
  if (isAdminView.value) {
    openDetailPane()
    await adminCenter.selectConversation(conversationId)
    return
  }

  const switched = await userInbox.selectConversation(conversationId)
  if (switched) {
    openDetailPane()
  }
}

const handleCreateTicket = async (): Promise<void> => {
  await userInbox.createTicket()
  if (userInbox.selectedConversationId.value) {
    showMobileTicketCompose.value = false
    openDetailPane()
  }
}

const handleReply = async (): Promise<void> => {
  if (isAdminView.value) {
    await adminCenter.reply()
    return
  }

  await userInbox.sendReply()
}

const updateStatus = async (status: 'open' | 'pending' | 'closed'): Promise<void> => {
  await adminCenter.updateStatus(status)
}

const sendSystemMessage = async (): Promise<void> => {
  await adminCenter.sendSystemMessage()
}

const handleSaveDraftAndSwitch = async (): Promise<void> => {
  if (await userInbox.saveDraftAndSwitch()) {
    openDetailPane()
  }
}

const handleDiscardDraftAndSwitch = async (): Promise<void> => {
  if (await userInbox.discardDraftAndSwitch()) {
    openDetailPane()
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

const senderLabel = (senderType: number): string => {
  if (senderType === 1) return '管理员'
  if (senderType === 2) return '系统'
  return isAdminView.value ? '用户' : '我'
}

const bubbleClass = (senderType: number): string => {
  if (senderType === 0) return 'mail-bubble-user'
  if (senderType === 1) return 'mail-bubble-admin'
  return 'mail-bubble-system'
}

const formatTime = (input: string): string => {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
</script>

<style scoped>
@reference "@/assets/main.css";

.mail-page {
  min-height: 100%;
  min-width: 0;
}

.mail-layout {
  display: grid;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  gap: 3rem;
}

.mail-pane,
.mail-detail-stack {
  min-height: 0;
  min-width: 0;
  max-width: 100%;
}

.mail-flat-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  max-width: 100%;
}

.mail-pane-header {
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  margin-bottom: 2rem;
}

.mail-pane-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
}

.mail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.mail-header-eyebrow {
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: none;
  color: var(--fsusblog-text-muted);
}

.mail-header-title,
.mail-subheader {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--fsusblog-text-primary);
  letter-spacing: 0;
}

.mail-filter {
  width: 10rem;
}

.mail-scroll-region {
  display: flex;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  flex: 1 1 auto;
}

.mail-scroll-frame {
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  flex: 1 1 auto;
}

.mail-scrollbar {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.mail-item-stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mail-item-entry {
  min-width: 0;
  max-width: 100%;
}

.mail-item {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  background: transparent;
  padding: 1.25rem 0;
  text-align: left;
  transition: background-color var(--fsus-motion-control) var(--fsus-motion-standard),
    border-color var(--fsus-motion-control) var(--fsus-motion-standard),
    color var(--fsus-motion-control) var(--fsus-motion-standard);
  border-bottom: 1px solid var(--fsusblog-panel-border);
}

.mail-item:last-child {
  border-bottom: none;
}

.mail-item:hover {
  @apply opacity-70;
}

.mail-item.active {
  @apply relative;
}

.mail-item.active::before {
  content: "";
  @apply absolute -left-4 top-[calc(50%-1rem)] h-8 w-[3px] bg-[var(--fsusblog-color-primary)];
}

.mail-item-top,
.mail-item-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-width: 0;
  max-width: 100%;
}

.mail-item-top-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
}

.mail-item-subject {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--fsusblog-text-primary);
}

.mail-item-preview,
.mail-item-meta {
  color: var(--fsusblog-text-tertiary);
}

.mail-item-preview {
  margin: 0.5rem 0 0.75rem;
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.mail-item-meta {
  font-size: 0.75rem;
  font-family: var(--tabular-nums);
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}

.mail-detail-stack {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: 4rem;
}

.mail-thread-flat-pane {
  min-height: 0;
  flex: 1 1 auto;
}

.mail-thread-region {
  padding-right: 1.5rem;
}

.mail-bubble {
  margin-bottom: 2rem;
  border-left: 2px solid var(--fsusblog-panel-border);
  padding-left: 1.5rem;
  min-width: 0;
  max-width: 100%;
}

.mail-bubble-user {
  border-left-color: var(--fsus-state-focus-border, var(--fsusblog-color-primary));
}

.mail-bubble-admin {
  border-left-color: var(--fsusblog-text-primary);
}

.mail-bubble-system {
  border-left-style: dashed;
}

.mail-bubble-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: none;
  letter-spacing: 0;
  color: var(--fsusblog-text-muted);
  margin-bottom: 0.75rem;
}

.mail-bubble-body {
  line-height: 1.8;
  color: var(--fsusblog-text-secondary);
  font-size: 0.95rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.mail-reply-form,
.mail-mobile-compose,
.mail-mobile-primary {
  margin-top: 1.5rem;
}

.mail-mobile-primary {
  display: flex;
  justify-content: flex-start;
}

.mail-draft-dialog-text {
  margin: 0;
  color: var(--fsusblog-text-secondary);
  line-height: 1.7;
}

.mail-empty {
  flex: 1 1 auto;
  display: flex;
  justify-content: center;
}

.mail-detail-title-group {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.75rem;
}

.mail-header-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-width: 0;
  max-width: 100%;
}

.mail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

@media (min-width: 1024px) {
  .mail-layout {
    grid-template-columns: minmax(20rem, 24rem) minmax(0, 1fr);
    gap: 4rem;
    min-height: calc(100dvh - 8rem);
  }

  .mail-list-pane {
    border-right: 1px solid var(--fsusblog-panel-border);
    padding-right: 4rem;
  }
}

@media (max-width: 1023px) {
  .mail-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 2.5rem;
  }

  .mail-flat-pane {
    min-height: calc(100dvh - 10rem);
  }
}
</style>
