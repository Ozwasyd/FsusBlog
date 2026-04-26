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
        <el-card shadow="never" class="mail-panel">
          <template #header>
            <div class="mail-header">
              <div>
                <div class="mail-header-eyebrow">会话目录</div>
                <div class="mail-header-title">{{ isAdminView ? '处理中会话' : '消息列表' }}</div>
              </div>
              <el-select v-if="isAdminView" v-model="adminFilter" name="adminConversationFilter" size="small" class="mail-filter">
                <el-option label="处理中" value="open" />
                <el-option label="待处理" value="pending" />
                <el-option label="已关闭" value="closed" />
                <el-option label="系统" value="system" />
                <el-option label="全部" value="all" />
              </el-select>
              <el-select v-else v-model="userFilter" name="userConversationFilter" size="small" class="mail-filter">
                <el-option label="全部" value="all" />
                <el-option label="未读" value="unread" />
                <el-option label="系统消息" value="system" />
                <el-option label="处理中" value="open" />
                <el-option label="待处理" value="pending" />
                <el-option label="已关闭" value="closed" />
              </el-select>
            </div>
          </template>

          <el-skeleton v-if="listLoading" :rows="8" animated />

          <el-empty v-else-if="conversations.length === 0" description="暂无会话" class="mail-empty" />

          <el-scrollbar v-else class="mail-scroll-region">
            <div class="mail-item-stack">
              <button
                v-for="item in conversations"
                :key="item.conversationId"
                type="button"
                class="mail-item"
                :class="{ active: item.conversationId === selectedConversationId }"
                @click="handleSelectConversation(item.conversationId)"
              >
                <div class="mail-item-top">
                  <span class="mail-item-subject" data-visual-dynamic>{{ item.subject }}</span>
                  <div class="mail-item-top-right">
                    <el-tag v-if="item.isSystemSource" size="small" effect="plain">系统</el-tag>
                    <el-tag size="small" :type="statusType(item.status)">{{ statusLabel(item.status) }}</el-tag>
                  </div>
                </div>
                <p class="mail-item-preview" data-visual-dynamic>{{ item.lastMessage?.bodyPreview || (isAdminView ? '暂无内容' : '暂无消息内容') }}</p>
                <div class="mail-item-meta">
                  <span data-visual-dynamic>{{ formatTime(item.lastMessageAt) }}</span>
                  <el-badge v-if="item.unreadCount > 0" :value="item.unreadCount" />
                </div>
              </button>
            </div>
          </el-scrollbar>

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

          <div v-else-if="isMobile" class="mail-mobile-compose">
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
        </el-card>
      </section>

      <section v-show="showDetailPane" class="mail-pane mail-detail-pane mail-detail-stack">
          <el-card shadow="never" class="mail-panel mail-thread-panel">
            <template #header>
              <div class="mail-header mail-header-detail">
                <div class="mail-detail-title-group">
                  <button v-if="isMobile" type="button" class="mail-back-button" @click="openListPane">
                    返回会话列表
                  </button>
                  <div class="mail-header-title-row">
                    <span class="mail-header-title" data-visual-dynamic>{{ detail?.subject || '请选择会话' }}</span>
                    <div class="mail-item-top-right" v-if="detail">
                      <el-tag v-if="detail.isSystemSource" size="small" effect="plain">系统</el-tag>
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
            </template>

            <el-empty
              v-if="isAdminView ? !adminSelectedConversation : !hasUserSelection"
              :description="isAdminView ? '请选择会话' : '从左侧选择会话或创建新工单'"
              class="mail-empty"
            />

            <el-skeleton v-else-if="detailLoading" :rows="10" animated />

            <template v-else>
              <el-scrollbar class="mail-scroll-region mail-thread-region">
                <div
                  v-for="msg in detail?.messages || []"
                  :key="msg.messageId"
                  class="mail-bubble"
                  :class="bubbleClass(msg.senderType)"
                >
                  <div class="mail-bubble-meta">
                    <span data-visual-dynamic>{{ msg.senderName || senderLabel(msg.senderType) }}</span>
                    <span data-visual-dynamic>{{ formatTime(msg.createdAt) }}</span>
                  </div>
                  <p class="mail-bubble-body" data-visual-dynamic>{{ msg.body }}</p>
                </div>
              </el-scrollbar>

              <el-divider />

              <el-form label-position="top" class="mail-reply-form">
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
                <el-button type="primary" :loading="replyLoading" :disabled="!detail?.canReply" @click="handleReply">
                  发送回复
                </el-button>
              </el-form>
            </template>
          </el-card>

          <el-card v-if="!isMobile && isAdminView" shadow="never" class="mail-panel mail-compose-panel">
            <template #header>
              <span class="mail-header-title">发送系统消息</span>
            </template>
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
          </el-card>

          <el-card v-else-if="!isMobile" shadow="never" class="mail-panel mail-compose-panel">
            <template #header>
              <span class="mail-header-title">新建申诉工单</span>
            </template>
            <el-form label-position="top">
              <el-form-item label="主题">
                <el-input v-model="createSubject" name="ticketSubjectDesktop" maxlength="160" show-word-limit placeholder="例如：账号误封申诉" />
              </el-form-item>
              <el-form-item label="内容">
                <el-input v-model="createBody" name="ticketBodyDesktop" type="textarea" :rows="4" maxlength="4000" show-word-limit placeholder="请描述问题与诉求" />
              </el-form-item>
              <el-button type="success" :loading="creating" @click="handleCreateTicket">提交工单</el-button>
            </el-form>
          </el-card>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAdminMessageCenter } from '@/composables/useAdminMessageCenter'
import { useInboxSplitView } from '@/composables/useInboxSplitView'
import { useUserMessagesInbox } from '@/composables/useUserMessagesInbox'
import { useUserStore } from '@/store/user'

const userStore = useUserStore()
const isAdminView = computed(() => userStore.isAdmin)

const adminCenter = useAdminMessageCenter(() => isAdminView.value)
const userInbox = useUserMessagesInbox(() => !isAdminView.value)

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
  const task = isAdminView.value
    ? adminCenter.selectConversation(conversationId)
    : userInbox.selectConversation(conversationId)
  openDetailPane()
  await task
}

const handleCreateTicket = async (): Promise<void> => {
  await userInbox.createTicket()
  if (userInbox.selectedConversationId.value) {
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
  gap: 1.25rem;
}

.mail-pane,
.mail-detail-stack {
  min-height: 0;
}

.mail-panel {
  height: 100%;
  border-radius: var(--fsus-radius-lg);
  border-color: var(--fsus-panel-border);
  background: rgba(255, 255, 255, 0.88);
  box-shadow:
    0 32px 64px rgba(15, 23, 42, 0.07),
    inset 0 1px 0 rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(calc(var(--fsus-backdrop-blur) * 0.7)) saturate(118%);
}

:deep(.mail-panel > .el-card__body) {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
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
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--fsus-text-muted);
}

.mail-header-title,
.mail-subheader {
  font-size: 1rem;
  font-weight: 700;
  color: var(--fsus-text-primary);
  letter-spacing: -0.02em;
}

.mail-filter {
  width: 10rem;
}

.mail-scroll-region {
  min-height: 0;
  flex: 1 1 auto;
}

.mail-item-stack {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.mail-item {
  width: 100%;
  border-radius: 18px;
  border: 1px solid rgba(228, 228, 231, 0.95);
  background: rgba(252, 252, 252, 0.9);
  padding: 1rem 1.05rem;
  text-align: left;
  transition: border-color 0.2s ease, background-color 0.2s ease, transform 0.2s ease;
}

.mail-item:hover {
  border-color: rgba(42, 89, 156, 0.22);
  transform: translateY(-1px);
}

.mail-item.active {
  border-color: rgba(42, 89, 156, 0.2);
  background: rgba(42, 89, 156, 0.08);
  box-shadow: inset 3px 0 0 #2A599C;
}

.mail-item-top,
.mail-item-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.mail-item-top-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.mail-item-subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--fsus-text-primary);
}

.mail-item-preview,
.mail-item-meta {
  color: var(--fsus-text-tertiary);
}

.mail-item-preview {
  margin: 0.5rem 0 0.75rem;
  line-height: 1.65;
}

.mail-item-meta {
  font-size: 0.75rem;
}

.mail-detail-stack {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: 1rem;
}

.mail-thread-panel {
  min-height: 0;
  flex: 1 1 auto;
}

.mail-thread-region {
  padding-right: 0.35rem;
}

.mail-bubble {
  margin-bottom: 0.75rem;
  border-radius: 18px;
  border: 1px solid rgba(228, 228, 231, 0.88);
  padding: 1rem 1.05rem;
}

.mail-bubble-user {
  background: rgba(42, 89, 156, 0.07);
}

.mail-bubble-admin {
  background: rgba(252, 252, 252, 0.96);
}

.mail-bubble-system {
  background: rgba(247, 247, 248, 0.94);
}

.mail-bubble-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.75rem;
  color: var(--fsus-text-muted);
}

.mail-bubble-body {
  margin-top: 0.6rem;
  line-height: 1.8;
  color: var(--fsus-text-secondary);
  white-space: pre-wrap;
}

.mail-reply-form,
.mail-mobile-compose {
  margin-top: 0.25rem;
}

.mail-empty {
  flex: 1 1 auto;
}

.mail-back-button {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  border-radius: var(--fsus-radius-full);
  border: 1px solid var(--fsus-panel-border);
  padding: 0.35rem 0.8rem;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fsus-text-tertiary);
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
}

.mail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

:deep(.mail-panel .el-card__header) {
  border-bottom: 1px solid var(--fsus-panel-border);
  padding: 1.25rem 1.25rem 1rem;
}

:deep(.mail-panel .el-card__body) {
  padding: 1.1rem 1.25rem 1.25rem;
}

:deep(.mail-panel .el-empty) {
  padding: 3.5rem 0;
}

:deep(.mail-panel .el-form-item__label) {
  color: var(--fsus-text-muted);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

:deep(.mail-panel .el-input__wrapper),
:deep(.mail-panel .el-textarea__inner),
:deep(.mail-panel .el-select__wrapper) {
  border-radius: var(--fsus-radius-sm);
}

@media (min-width: 1024px) {
  .mail-layout {
    grid-template-columns: minmax(20rem, 24rem) minmax(0, 1fr);
    gap: 1.5rem;
    min-height: calc(100dvh - 8rem);
  }
}

@media (max-width: 1023px) {
  .mail-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .mail-panel {
    min-height: calc(100dvh - 10rem);
  }
}
</style>
