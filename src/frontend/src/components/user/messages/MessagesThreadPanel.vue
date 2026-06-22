<template>
  <section
    ref="paneRef"
    class="messages-inbox-pane messages-detail-pane messages-thread-panel"
    tabindex="-1"
    aria-live="polite"
    :aria-busy="loading"
    aria-labelledby="messages-thread-title"
  >
    <div class="messages-flat-pane messages-thread-flat-pane">
      <header class="messages-pane-header messages-pane-header-detail">
        <div class="messages-header messages-header-detail">
          <div class="messages-detail-title-group">
            <el-button
              v-if="isMobile"
              size="small"
              aria-label="返回会话列表"
              aria-controls="messages-list-title"
              @click="emit('back')"
            >
              返回会话列表
            </el-button>
            <div class="messages-header-title-row">
              <h2 id="messages-thread-title" class="messages-header-title" data-visual-dynamic>
                {{ detail?.subject || '请选择会话' }}
              </h2>
              <div v-if="detail" class="messages-conversation-tags">
                <el-tag v-if="detail.isSystemSource" size="small">系统</el-tag>
                <el-tag size="small" :type="statusType(detail.status)">{{ statusLabel(detail.status) }}</el-tag>
              </div>
            </div>
          </div>

          <div v-if="isAdminMode && detail" class="messages-actions">
            <span class="messages-action-hint">状态变更会通知用户</span>
            <el-button size="small" :disabled="processing" @click="emit('updateStatus', 'open')">标记为处理中</el-button>
            <el-button size="small" type="warning" :disabled="processing" @click="emit('updateStatus', 'pending')">移回待处理</el-button>
            <el-button size="small" type="success" :disabled="processing" @click="emit('updateStatus', 'closed')">关闭会话</el-button>
          </div>
        </div>
      </header>

      <div class="messages-pane-body messages-thread-body">
        <MessagesEmptyState
          v-if="selectionEmpty"
          class="messages-thread-empty"
          :title="isAdminMode ? '请选择会话' : '请选择会话或创建新工单'"
          :description="isAdminMode ? '从左侧选择一条待处理会话。' : '会话详情和回复框会在这里打开。'"
        >
          <template v-if="!isAdminMode" #action>
            <el-button type="primary" @click="emit('createTicket')">新建工单</el-button>
          </template>
        </MessagesEmptyState>

        <el-skeleton v-else-if="loading" :rows="10" animated />

        <template v-else>
          <div v-if="detail" class="messages-context-bar">
            <span>正在回复：{{ detail.subject }}</span>
            <span>{{ isAdminMode ? `账号 ${contextAccountText}` : '当前会话' }}</span>
            <span>状态：{{ statusLabel(detail.status) }}</span>
          </div>

          <div class="messages-thread-scroll">
            <p
              v-if="motionSummary"
              class="blog-motion-summary-enter messages-motion-summary"
              role="status"
              aria-live="polite"
            >
              {{ motionSummary }}
            </p>
            <div
              v-for="msg in rows"
              :key="msg.messageId"
              class="messages-bubble"
              :class="[msg.bubbleClassName, msg.motionClass]"
              v-memo="[msg.messageId, msg.body, msg.createdAtText, msg.motionClass]"
            >
              <div class="messages-bubble-meta">
                <span data-visual-dynamic>{{ msg.senderText }}</span>
                <time :datetime="msg.createdAt" data-visual-dynamic>{{ msg.createdAtText }}</time>
              </div>
              <p class="messages-bubble-body" data-visual-dynamic>{{ msg.body }}</p>
            </div>
            <el-button
              v-if="hiddenCount > 0"
              link
              type="primary"
              class="messages-window-more"
              @click="emit('loadMore')"
            >
              显示更早消息（{{ hiddenCount }}）
            </el-button>
          </div>

          <el-divider />

          <div class="messages-reply-form">
            <div class="messages-subheader">回复当前会话</div>
            <el-form label-position="top">
              <el-form-item :label="isAdminMode ? '回复' : '回复管理员'">
                <el-input
                  :model-value="replyBody"
                  name="conversationReply"
                  type="textarea"
                  :rows="4"
                  maxlength="4000"
                  show-word-limit
                  :disabled="replyDisabled"
                  placeholder="请输入回复内容"
                  @update:model-value="handleReplyBodyUpdate"
                />
              </el-form-item>
              <el-button
                type="primary"
                :loading="replyLoading"
                :disabled="replyDisabled || !replyBody.trim()"
                @click="emit('reply')"
              >
                发送回复
              </el-button>
            </el-form>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ConversationDetailResponse, ConversationMessageResponse, ConversationStatus } from '@/api/message'
import MessagesEmptyState from './MessagesEmptyState.vue'

type MessageRow = ConversationMessageResponse & {
  createdAtText: string
  senderText: string
  bubbleClassName: string
  motionClass: string
}

const props = defineProps<{
  mode: 'admin' | 'account'
  isMobile: boolean
  loading: boolean
  processing: boolean
  detail: ConversationDetailResponse | null
  selectionEmpty: boolean
  rows: MessageRow[]
  hiddenCount: number
  replyBody: string
  replyLoading: boolean
  replyDisabled: boolean
  contextAccountText: string
  motionSummary?: string
  statusLabel: (status: number) => string
  statusType: (status: number) => 'warning' | 'success' | ''
}>()

const emit = defineEmits<{
  'update:replyBody': [value: string]
  back: []
  createTicket: []
  reply: []
  updateStatus: [status: ConversationStatus]
  loadMore: []
}>()

const paneRef = ref<HTMLElement | null>(null)
const isAdminMode = computed(() => props.mode === 'admin')

const handleReplyBodyUpdate = (value: string): void => {
  emit('update:replyBody', value)
}

defineExpose({
  focusPane: () => {
    paneRef.value?.focus()
  }
})
</script>

<style scoped>
@reference "@/assets/main.css";

.messages-inbox-pane {
  min-height: 0;
  min-width: 0;
  max-width: 100%;
}

.messages-detail-pane {
  min-height: 100%;
}

.messages-flat-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  max-width: 100%;
}

.messages-thread-flat-pane {
  min-height: 0;
  flex: 1 1 auto;
}

.messages-pane-header {
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  margin-bottom: 2rem;
}

.messages-pane-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
}

.messages-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.messages-header-title,
.messages-subheader {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: 0;
}

.messages-header-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-width: 0;
  max-width: 100%;
}

.messages-detail-title-group {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.75rem;
}

.messages-conversation-tags {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
}

.messages-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}

.messages-action-hint {
  align-self: center;
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.messages-thread-empty {
  margin-top: 0.25rem;
}

.messages-context-bar {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 0.75rem;
  border-left: 2px solid var(--fsusblog-color-primary);
  background: var(--fsusblog-page-bg-soft);
  margin-bottom: 1.5rem;
  padding: 0.85rem 1rem;
  color: var(--fsusblog-text-secondary);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1.5;
}

.messages-thread-scroll {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  overflow: auto;
  padding-right: 1.5rem;
}

.messages-bubble {
  margin-bottom: 2rem;
  border-left: 2px solid var(--fsusblog-panel-border);
  padding-left: 1.5rem;
  min-width: 0;
  max-width: 100%;
}

.messages-bubble-account {
  border-left-color: var(--fsus-state-focus-border, var(--fsusblog-color-primary));
}

.messages-bubble-admin {
  border-left-color: var(--fsusblog-text-primary);
}

.messages-bubble-system {
  border-left-style: dashed;
}

.messages-bubble-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  color: var(--fsusblog-text-muted);
  margin-bottom: 0.75rem;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: none;
}

.messages-bubble-body {
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  line-height: 1.8;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.messages-window-more {
  margin-top: 0.75rem;
}

.messages-reply-form {
  margin-top: 1.5rem;
}

@media (max-width: 1023px) {
  .messages-flat-pane {
    min-height: calc(100dvh - 10rem);
  }
}
</style>
