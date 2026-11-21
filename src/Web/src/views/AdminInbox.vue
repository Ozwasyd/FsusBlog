<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElConversationContextBar, ElConversationList, ElEmptySelectionState,
  ElInboxEmptyState, ElInboxLayout, ElInput, ElMessageBubble, ElMessageTimeline,
  ElOption, ElReplyComposerShell, ElSelect, ElSkeleton, ElTag, ElThreadPanel,
} from '@ozwasyd/element-plus'
import { isNoticeRecipient } from '../../../Contracts/admin-inbox-notice'
import type { AdminInboxStatus, AdminInboxThread } from '../../../Contracts/admin-inbox'
import {
  AdminInboxController,
  adminInboxStatusTransitions as transitions,
} from '../admin/adminInboxController'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: unknown] }>()

const title = ref<HTMLElement>()
const threadPanel = ref<HTMLElement>()
const queue = ref<HTMLElement>()
const statuses = ['admin.inbox.m6', 'admin.inbox.m7', 'admin.inbox.m8'] as const
const senders = ['admin.inbox.m30', 'admin.inbox.m31', 'admin.inbox.m32'] as const
const statusTagTypes = ['', 'warning', 'info'] as const

let opener: HTMLElement | undefined

function statusTagType(status: AdminInboxStatus) {
  return statusTagTypes[status]
}

function messageVariant(message: AdminInboxThread['messages'][number]): 'other' | 'self' | 'system' | 'muted' {
  if (message.internal) return 'muted'
  if (message.sender === 1) return 'self'
  if (message.sender === 2) return 'system'
  return 'other'
}

const controller = new AdminInboxController({
  hooks: {
    onSessionLost: error => emit('sessionLost', error),
    onReset: () => { opener = undefined },
    onThreadOpened: async () => {
      await nextTick()
      title.value?.focus()
    },
    onThreadRefreshed: () => nextTick(),
    onThreadClosed: () => {
      void nextTick(() => {
        if (opener?.isConnected) opener.focus()
      })
    },
    onBeforeApplyLatestThread: conversationId => {
      const focus = document.activeElement
      const focusedInThread = focus && threadPanel.value?.contains(focus)
      if (!focusedInThread) return
      return () => {
        void nextTick(() => {
          if (!props.sessionSignal.aborted && state.value.thread?.conversation.id === conversationId &&
              !focus.isConnected && document.activeElement === document.body) {
            title.value?.focus()
          }
        })
      }
    },
    onBeforeApplyLiveQueuePage: () => {
      const focus = document.activeElement
      const focusedInQueue = focus && queue.value?.contains(focus)
      if (!focusedInQueue) return
      return () => {
        void nextTick(() => {
          if (!props.sessionSignal.aborted && !focus.isConnected && document.activeElement === document.body) {
            queue.value?.focus()
          }
        })
      }
    },
  },
})

controller.bindSession(props.sessionSignal, { autoLoad: false })
const state = shallowRef(controller.snapshot())
const unsubscribe = controller.subscribe(() => {
  state.value = controller.snapshot()
})

const rows = computed(() => state.value.rows)
const thread = computed(() => state.value.thread)
const next = computed(() => state.value.next)
const filter = computed({
  get: () => state.value.filter,
  set: value => controller.setFilter(value),
})
const order = computed({
  get: () => state.value.order,
  set: value => controller.setOrder(value),
})
const expanded = computed(() => state.value.expanded)
const pending = computed(() => state.value.pending)
const failed = computed(() => state.value.failed)
const reply = computed({
  get: () => state.value.reply,
  set: value => controller.setReply(value),
})
const notice = computed(() => state.value.notice)
const destination = computed({
  get: () => state.value.destination,
  set: value => controller.setDestination(value),
})
const reason = computed({
  get: () => state.value.reason,
  set: value => controller.setReason(value),
})
const needsRefresh = computed(() => state.value.needsRefresh)
const sharedRead = computed(() => state.value.sharedRead)
const activityAvailable = computed(() => state.value.activityAvailable)
const unreadAckFailed = computed(() => state.value.unreadAckFailed)
const noticesEnabled = computed(() => state.value.noticesEnabled)
const composeNotice = computed({
  get: () => state.value.composeNotice,
  set: value => controller.setComposeNotice(value),
})
const recipient = computed({
  get: () => state.value.recipient,
  set: value => controller.setRecipient(value),
})
const noticeSubject = computed({
  get: () => state.value.noticeSubject,
  set: value => controller.setNoticeSubject(value),
})
const noticeBody = computed({
  get: () => state.value.noticeBody,
  set: value => controller.setNoticeBody(value),
})

function openThread(id: bigint, before: string | null = null, event?: MouseEvent) {
  if (event?.currentTarget instanceof HTMLElement) opener = event.currentTarget
  void controller.openThread(id, before)
}

const closeThread = () => controller.closeThread()
const loadQueue = (cursor: string | null = null) => { void controller.loadQueue(cursor) }
const retryRead = () => { void controller.retryRead() }
const clearNotice = () => controller.clearNotice()
const sendNotice = () => { void controller.sendNotice() }
const sendReply = () => { void controller.sendReply() }
const saveStatus = () => { void controller.saveStatus() }
const reloadThread = () => { void controller.reloadThread() }
const toggle = () => controller.toggle()

watch(() => props.sessionSignal, signal => {
  controller.bindSession(signal, { autoLoad: true })
}, { flush: 'sync' })

onMounted(() => {
  if (state.value.expanded && !props.sessionSignal.aborted) loadQueue()
})

onBeforeUnmount(() => {
  unsubscribe()
  controller.dispose()
})
</script>

<template>
  <section class="inbox-admin" aria-labelledby="admin-inbox-title">
    <h2 id="admin-inbox-title" class="inbox-admin-sr-title">{{ t('admin.inbox.m1') }}</h2>
    <div class="inbox-admin-panel-actions">
      <ElButton native-type="button" @click="toggle">{{ t(expanded ? 'admin.inbox.m2' : 'admin.inbox.m3') }}</ElButton>
    </div>

    <template v-if="expanded">
      <ElAlert v-if="failed" :title="t(failed)" type="error" :closable="false" />

      <ElInboxLayout
        :selected="Boolean(thread)"
        :mobile-pane="thread ? 'detail' : 'list'"
        density="compact"
      >
        <template #list>
          <div ref="queue" class="inbox-admin-queue" tabindex="-1" :aria-busy="pending">
            <div class="inbox-admin-toolbar">
              <div class="inbox-admin-filters">
                <ElSelect v-model="filter" :ariaLabel="t('admin.inbox.m4')" :disabled="pending">
                  <ElOption :label="t('admin.inbox.m5')" value="" />
                  <ElOption :label="t('admin.inbox.m6')" value="open" />
                  <ElOption :label="t('admin.inbox.m7')" value="pending" />
                  <ElOption :label="t('admin.inbox.m8')" value="closed" />
                  <ElOption v-if="sharedRead" :label="t('admin.inbox.m9')" value="unread" />
                  <ElOption v-if="sharedRead" :label="t('admin.inbox.m10')" value="system" />
                </ElSelect>
                <ElSelect v-if="activityAvailable" v-model="order" :ariaLabel="t('admin.inbox.m11')" :disabled="pending">
                  <ElOption :label="t('admin.inbox.m12')" value="created" />
                  <ElOption :label="t('admin.inbox.m13')" value="activity" />
                </ElSelect>
              </div>
              <div class="inbox-admin-toolbar-actions">
                <ElButton native-type="button" text :loading="pending" @click="loadQueue()">{{ t('admin.inbox.m14') }}</ElButton>
                <ElButton v-if="noticesEnabled && !composeNotice" native-type="button" :disabled="pending"
                  @click="composeNotice = true">{{ t('admin.inbox.m15') }}</ElButton>
              </div>
            </div>

            <form v-if="noticesEnabled && composeNotice" class="inbox-admin-notice-form" @submit.prevent="sendNotice">
              <div class="inbox-admin-field">
                <label for="admin-notice-account">{{ t('admin.inbox.m16') }}</label>
                <ElInput id="admin-notice-account" v-model="recipient" :disabled="pending" />
              </div>
              <div class="inbox-admin-field">
                <label for="admin-notice-subject">{{ t('admin.inbox.m17') }}</label>
                <ElInput id="admin-notice-subject" v-model="noticeSubject" :disabled="pending" />
              </div>
              <div class="inbox-admin-field">
                <label for="admin-notice-body">{{ t('admin.inbox.m18') }}</label>
                <ElInput id="admin-notice-body" v-model="noticeBody" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :disabled="pending" />
              </div>
              <div class="inbox-admin-notice-actions">
                <ElButton native-type="submit" type="primary" :loading="pending"
                  :disabled="!isNoticeRecipient(recipient.trim()) || !noticeBody.trim()">{{ t('admin.inbox.m19') }}</ElButton>
                <ElButton native-type="button" :disabled="pending" @click="clearNotice">{{ t('admin.inbox.m20') }}</ElButton>
              </div>
            </form>

            <ElSkeleton v-if="pending && rows.length === 0" :rows="4" class="inbox-admin-skeleton" />
            <ElInboxEmptyState
              v-else-if="!pending && !failed && rows.length === 0"
              :title="t('admin.inbox.m21')"
            />
            <ElConversationList v-if="rows.length" class="inbox-admin-list">
              <div
                v-for="item in rows"
                :key="String(item.id)"
                class="inbox-admin-item"
                :class="{ 'is-selected': thread?.conversation.id === item.id }"
                role="listitem"
              >
                <button
                  type="button"
                  class="inbox-admin-subject"
                  :disabled="pending"
                  @click="openThread(item.id, null, $event)"
                >{{ item.subject }}</button>
                <div class="inbox-admin-item-meta">
                  <ElTag size="small" :type="statusTagType(item.status)">{{ t(statuses[item.status]) }}</ElTag>
                  <small>{{ t(item.system ? 'admin.inbox.m22' : 'admin.inbox.m23') }}</small>
                  <small v-if="item.unread" class="inbox-admin-unread">{{ t('admin.inbox.m47', { count: item.unread }) }}</small>
                </div>
              </div>
            </ElConversationList>

            <div v-if="next" class="inbox-admin-more">
              <ElButton native-type="button" text :disabled="pending" @click="loadQueue(next)">{{ t('admin.inbox.m24') }}</ElButton>
            </div>
          </div>
        </template>

        <template #detail>
          <div v-if="thread" ref="threadPanel" class="inbox-admin-thread" :aria-busy="pending">
            <ElThreadPanel title-tag="h3" density="compact">
              <template #back>
                <ElButton native-type="button" text :disabled="pending" @click="closeThread">{{ t('admin.inbox.m25') }}</ElButton>
              </template>
              <template #title>
                <span id="admin-inbox-thread" ref="title" tabindex="-1">{{ thread.conversation.subject }}</span>
              </template>
              <template #actions>
                <ElButton
                  v-if="thread.version || thread.liveEnabled || needsRefresh"
                  native-type="button"
                  text
                  :disabled="pending"
                  @click="reloadThread"
                >{{ t('admin.inbox.m26') }}</ElButton>
              </template>
              <template #context>
                <ElConversationContextBar>
                  <ElTag size="small" :type="statusTagType(thread.conversation.status)">{{ t(statuses[thread.conversation.status]) }}</ElTag>
                  <span>{{ t(thread.conversation.system ? 'admin.inbox.m22' : 'admin.inbox.m23') }}</span>
                  <span class="inbox-admin-account">{{ t('admin.inbox.m48', { account: thread.conversation.account }) }}</span>
                  <ElTag v-if="thread.conversation.unread" size="small" type="info">{{ t('admin.inbox.m47', { count: thread.conversation.unread }) }}</ElTag>
                </ElConversationContextBar>
                <div v-if="unreadAckFailed" class="inbox-admin-alert-row">
                  <ElAlert :title="t('admin.inbox.m27')" type="warning" :closable="false" />
                  <ElButton native-type="button" :disabled="pending" @click="retryRead">{{ t('admin.inbox.m28') }}</ElButton>
                </div>
              </template>
              <template #messages>
                <div v-if="thread.previous" class="inbox-admin-earlier">
                  <ElButton native-type="button" text :disabled="pending"
                    @click="openThread(thread.conversation.id, thread.previous)">{{ t('admin.inbox.m29') }}</ElButton>
                </div>
                <ElMessageTimeline>
                  <ElMessageBubble
                    v-for="message in thread.messages"
                    :key="String(message.id)"
                    :variant="messageVariant(message)"
                    :author="`${t(senders[message.sender])}${message.internal ? ` · ${t('admin.inbox.m49')}` : ''}`"
                    :meta="new Date(message.at).toLocaleString()"
                  >{{ message.body }}</ElMessageBubble>
                </ElMessageTimeline>
              </template>
              <template v-if="(thread.repliesEnabled && thread.conversation.status !== 2) || thread.version" #composer>
                <div class="inbox-admin-composer-stack">
                  <form v-if="thread.repliesEnabled && thread.conversation.status !== 2" @submit.prevent="sendReply">
                    <ElReplyComposerShell :title="t('admin.inbox.m33')" density="compact">
                      <template #input>
                        <ElInput
                          id="admin-inbox-reply"
                          v-model="reply"
                          type="textarea"
                          v-bind="{ 'aria-label': t('admin.inbox.m33') }"
                          :autosize="{ minRows: 3, maxRows: 8 }"
                          :disabled="pending"
                        />
                      </template>
                      <template #actions>
                        <ElButton native-type="submit" type="primary" :loading="pending" :disabled="!reply.trim()">{{ t('admin.inbox.m34') }}</ElButton>
                      </template>
                    </ElReplyComposerShell>
                  </form>
                  <form v-if="thread.version" class="inbox-admin-status-form" @submit.prevent="saveStatus">
                    <div class="inbox-admin-status-row">
                      <ElSelect v-model="destination" :ariaLabel="t('admin.inbox.m35')" :placeholder="t('admin.inbox.m36')" :disabled="pending">
                        <ElOption v-for="option in transitions[thread.conversation.status]" :key="option" :label="t(statuses[option])" :value="option" />
                      </ElSelect>
                      <div class="inbox-admin-field">
                        <label for="admin-inbox-status-reason">{{ t('admin.inbox.m37') }}</label>
                        <ElInput id="admin-inbox-status-reason" v-model="reason" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :disabled="pending" />
                      </div>
                    </div>
                    <div class="inbox-admin-status-actions">
                      <ElButton native-type="submit" :loading="pending"
                        :disabled="destination === undefined || !reason.trim() || reason.trim().length > 256">{{ t('admin.inbox.m38') }}</ElButton>
                    </div>
                  </form>
                </div>
              </template>
            </ElThreadPanel>
          </div>
          <ElEmptySelectionState v-else :title="t('admin.inbox.m1')" />
        </template>
      </ElInboxLayout>

      <p v-if="notice" class="inbox-admin-notice" role="status">{{ t(notice) }}</p>
    </template>
  </section>
</template>

<style scoped>
.inbox-admin {
  display: grid;
  gap: var(--fsus-space-2, 12px);
}

.inbox-admin-sr-title {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.inbox-admin-panel-actions {
  display: flex;
  justify-content: flex-end;
}

.inbox-admin-queue {
  display: grid;
  align-content: start;
  min-width: 0;
}

.inbox-admin-toolbar {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-blank));
}

.inbox-admin-filters,
.inbox-admin-toolbar-actions,
.inbox-admin-notice-actions,
.inbox-admin-status-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.inbox-admin-notice-form,
.inbox-admin-status-form {
  display: grid;
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}

.inbox-admin-status-form {
  border-bottom: 0;
  border-top: 1px solid var(--el-border-color-lighter);
}

.inbox-admin-field {
  display: grid;
  gap: 6px;
}

.inbox-admin-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
}

.inbox-admin-skeleton {
  padding: 12px;
}

.inbox-admin-item {
  display: grid;
  gap: 6px;
  padding: 12px;
  border-left: 3px solid transparent;
  background: transparent;
  transition: background-color 140ms ease, border-color 140ms ease;
}

.inbox-admin-item + .inbox-admin-item {
  border-top: 1px solid var(--el-border-color-lighter);
}

.inbox-admin-item:hover {
  background: var(--el-fill-color-light);
}

.inbox-admin-item.is-selected {
  border-left-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.inbox-admin-subject {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: var(--el-font-size-base);
  font-weight: 600;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.inbox-admin-subject:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
  border-radius: var(--fsus-radius-control, 4px);
}

.inbox-admin-item-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
}

.inbox-admin-unread {
  color: var(--el-color-primary);
  font-weight: 600;
}

.inbox-admin-more,
.inbox-admin-earlier {
  display: flex;
  justify-content: center;
  padding: 8px 12px;
}

.inbox-admin-thread {
  display: grid;
  min-width: 0;
  min-height: 100%;
}

.inbox-admin-alert-row {
  display: grid;
  gap: 8px;
  padding: 8px 16px 12px;
}

.inbox-admin-composer-stack {
  display: grid;
}

.inbox-admin-status-row {
  display: grid;
  gap: 10px;
}

.inbox-admin-account {
  overflow-wrap: anywhere;
}

.inbox-admin-notice {
  margin: 0;
  font-size: var(--el-font-size-small);
  color: var(--el-text-color-secondary);
}
</style>
