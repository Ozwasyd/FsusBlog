<template>
  <section
    ref="paneRef"
    class="messages-inbox-pane messages-list-pane"
    tabindex="-1"
    aria-labelledby="messages-list-title"
  >
    <div class="messages-flat-pane">
      <header class="messages-pane-header">
        <div class="messages-header">
          <h2 id="messages-list-title" class="messages-header-title">
            {{ isAdminMode ? '处理中会话' : '消息列表' }}
          </h2>
          <div class="messages-filter">
            <el-select
              :model-value="filter"
              :name="isAdminMode ? 'adminConversationFilter' : 'accountConversationFilter'"
              size="small"
              @update:model-value="handleFilterUpdate"
            >
              <el-option
                v-for="option in filterOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </div>
        </div>
      </header>

      <div class="messages-pane-body">
        <div v-if="isMobile && !isAdminMode" class="messages-mobile-primary">
          <el-button type="primary" @click="emit('createTicket')">新建工单</el-button>
        </div>

        <el-skeleton v-if="loading" :rows="8" animated />

        <MessagesEmptyState
          v-else-if="rows.length === 0"
          class="messages-list-empty"
          :title="isAdminMode ? '暂无待处理会话' : '暂无站内信'"
          :description="isAdminMode ? '当前筛选下没有需要处理的消息。' : '新的通知、系统消息和申诉工单会出现在这里。'"
        >
          <template v-if="!isAdminMode" #action>
            <el-button type="primary" @click="emit('createTicket')">新建工单</el-button>
          </template>
        </MessagesEmptyState>

        <div v-else class="messages-list-scroll">
          <p
            v-if="motionSummary"
            class="blog-motion-summary-enter messages-motion-summary"
            role="status"
            aria-live="polite"
          >
            {{ motionSummary }}
          </p>
          <ul class="messages-conversation-stack" aria-label="会话列表">
            <li
              v-for="item in rows"
              :key="item.conversationId"
              class="messages-conversation-entry"
              v-memo="[item.conversationId, item.subject, item.lastMessageAtText, item.unreadCount, item.status, rowClassKey(item)]"
            >
              <button
                type="button"
                class="messages-conversation-item"
                :class="conversationRowClass(item)"
                :aria-current="item.conversationId === selectedConversationId ? 'true' : undefined"
                :aria-label="item.ariaLabel"
                @click="emit('select', item.conversationId)"
              >
                <div class="messages-conversation-top">
                  <span class="messages-conversation-subject" data-visual-dynamic>{{ item.subject }}</span>
                  <div class="messages-conversation-tags">
                    <el-tag v-if="item.isSystemSource" size="small">系统</el-tag>
                    <el-tag size="small" :type="statusType(item.status)">{{ statusLabel(item.status) }}</el-tag>
                  </div>
                </div>
                <p class="messages-conversation-preview" data-visual-dynamic>
                  {{ item.lastMessage?.bodyPreview || (isAdminMode ? '暂无内容' : '暂无消息内容') }}
                </p>
                <div class="messages-conversation-meta">
                  <time :datetime="item.lastMessageAt" data-visual-dynamic>{{ item.lastMessageAtText }}</time>
                  <el-badge v-if="item.unreadCount > 0" :value="item.unreadCount" />
                </div>
              </button>
            </li>
          </ul>
          <el-button
            v-if="hiddenCount > 0"
            link
            type="primary"
            class="messages-window-more"
            @click="emit('loadMore')"
          >
            显示更多会话（{{ hiddenCount }}）
          </el-button>
        </div>

        <slot name="mobile-compose" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ConversationFilter, ConversationListItemResponse } from '@/api/message'
import MessagesEmptyState from './MessagesEmptyState.vue'

type ConversationRow = ConversationListItemResponse & {
  lastMessageAtText: string
  ariaLabel: string
}

const props = defineProps<{
  mode: 'admin' | 'account'
  isMobile: boolean
  loading: boolean
  filter: ConversationFilter
  rows: ConversationRow[]
  hiddenCount: number
  selectedConversationId: string
  motionSummary?: string
  statusLabel: (status: number) => string
  statusType: (status: number) => 'warning' | 'success' | ''
  conversationRowClass: (item: ConversationRow) => string[]
}>()

const emit = defineEmits<{
  'update:filter': [value: ConversationFilter]
  select: [conversationId: string]
  createTicket: []
  loadMore: []
}>()

const paneRef = ref<HTMLElement | null>(null)
const isAdminMode = computed(() => props.mode === 'admin')
const filterOptions = computed(() =>
  isAdminMode.value
    ? [
        { label: '处理中', value: 'open' },
        { label: '待处理', value: 'pending' },
        { label: '已关闭', value: 'closed' },
        { label: '系统', value: 'system' },
        { label: '全部', value: 'all' }
      ] satisfies { label: string; value: ConversationFilter }[]
    : [
        { label: '全部', value: 'all' },
        { label: '未读', value: 'unread' },
        { label: '系统消息', value: 'system' },
        { label: '处理中', value: 'open' },
        { label: '待处理', value: 'pending' },
        { label: '已关闭', value: 'closed' }
      ] satisfies { label: string; value: ConversationFilter }[]
)

const handleFilterUpdate = (value: unknown): void => {
  emit('update:filter', value as ConversationFilter)
}

const rowClassKey = (item: ConversationRow): string => props.conversationRowClass(item).join(' ')

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

.messages-flat-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  max-width: 100%;
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

.messages-header-title {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: 0;
}

.messages-filter {
  width: 10rem;
}

.messages-mobile-primary {
  display: flex;
  justify-content: flex-start;
  margin-top: 1.5rem;
}

.messages-list-empty {
  margin-top: 0.25rem;
}

.messages-list-scroll {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  overflow: auto;
}

.messages-conversation-stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.messages-conversation-entry {
  min-width: 0;
  max-width: 100%;
}

.messages-window-more {
  margin-top: 0.75rem;
}

.messages-conversation-item {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  background: transparent;
  padding: 1.25rem 0;
  text-align: left;
  transition: background-color var(--fsus-motion-control) var(--fsus-motion-standard),
    border-color var(--fsus-motion-control) var(--fsus-motion-standard),
    color var(--fsus-motion-control) var(--fsus-motion-standard);
}

.messages-conversation-item:last-child {
  border-bottom: none;
}

.messages-conversation-item:hover {
  @apply opacity-70;
}

.messages-conversation-item.active {
  @apply relative;
}

.messages-conversation-item.active::before {
  content: "";
  @apply absolute -left-4 top-[calc(50%-1rem)] h-8 w-[3px] bg-[var(--fsusblog-color-primary)];
}

.messages-conversation-top,
.messages-conversation-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-width: 0;
  max-width: 100%;
}

.messages-conversation-tags {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
  min-width: 0;
}

.messages-conversation-subject {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fsusblog-text-primary);
  font-size: 0.9375rem;
  font-weight: 700;
}

.messages-conversation-preview,
.messages-conversation-meta {
  color: var(--fsusblog-text-tertiary);
}

.messages-conversation-preview {
  margin: 0.5rem 0 0.75rem;
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.messages-conversation-meta {
  font-family: var(--tabular-nums);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}

@media (min-width: 1024px) {
  .messages-list-pane {
    border-right: 1px solid var(--fsusblog-panel-border);
    padding-right: 4rem;
  }
}

@media (max-width: 1023px) {
  .messages-flat-pane {
    min-height: calc(100dvh - 10rem);
  }
}
</style>
