<script setup lang="ts">
import { siteLocale, t } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElInlineActions,
  ElInput,
  ElOption,
  ElSelect,
  ElTag,
} from '@ozwasyd/element-plus'
import { isNoticeRecipient } from '../../../Contracts/admin-inbox-notice'
import InboxSplitWorkspace from '../components/InboxSplitWorkspace.vue'
import {
  AdminInboxController,
  adminInboxStatusTransitions as transitions,
  type AdminInboxState,
} from '../admin/adminInboxController'
import { useDelayedBusy } from '../delayedBusy'
import {
  createInboxTimeFormatter,
  inboxBubbleVariant,
  inboxStatusTagType,
  type InboxRenderedMessage,
} from '../inboxPresentation'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: unknown] }>()

const workspace = ref<InstanceType<typeof InboxSplitWorkspace>>()
const statuses = ['admin.inbox.m6', 'admin.inbox.m7', 'admin.inbox.m8'] as const
const senders = ['admin.inbox.m30', 'admin.inbox.m31', 'admin.inbox.m32'] as const
const timeFormat = computed(() => createInboxTimeFormatter(siteLocale.value))

let opener: HTMLElement | undefined

const controller = new AdminInboxController({
  hooks: {
    onSessionLost: error => emit('sessionLost', error),
    onReset: () => { opener = undefined },
    onThreadOpened: async () => {
      await nextTick()
      workspace.value?.focusThreadHeading()
    },
    onThreadRefreshed: () => nextTick(),
    onThreadClosed: () => {
      void nextTick(() => {
        if (opener?.isConnected) opener.focus({ preventScroll: true })
      })
    },
    onBeforeApplyLatestThread: conversationId => {
      const focus = document.activeElement
      if (!workspace.value?.containsThreadFocus(focus)) return
      return () => {
        void nextTick(() => {
          if (!props.sessionSignal.aborted && thread.value?.conversation.id === conversationId &&
              focus && !focus.isConnected && document.activeElement === document.body) {
            workspace.value?.focusThreadHeading()
          }
        })
      }
    },
    onBeforeApplyLiveQueuePage: () => {
      const focus = document.activeElement
      if (!workspace.value?.containsListFocus(focus)) return
      return () => {
        void nextTick(() => {
          if (!props.sessionSignal.aborted && focus && !focus.isConnected && document.activeElement === document.body) {
            workspace.value?.focusList()
          }
        })
      }
    },
  },
})

controller.bindSession(props.sessionSignal, { autoLoad: false })
const initial = controller.snapshot()

const rows = shallowRef(initial.rows)
const thread = shallowRef(initial.thread)
const next = ref(initial.next)
const filterValue = ref(initial.filter)
const orderValue = ref(initial.order)
const queuePending = ref(initial.queuePending)
const threadPending = ref(initial.threadPending)
const queueAction = ref<'refresh' | 'more' | null>(null)
const threadAction = ref<'reload' | 'earlier' | null>(null)
const queueRefreshLoading = useDelayedBusy(() => queuePending.value && queueAction.value === 'refresh')
const queueMoreLoading = useDelayedBusy(() => queuePending.value && queueAction.value === 'more')
const threadReloadLoading = useDelayedBusy(() => threadPending.value && threadAction.value === 'reload')
const threadEarlierLoading = useDelayedBusy(() => threadPending.value && threadAction.value === 'earlier')
const readPending = ref(initial.readPending)
const replyPending = ref(initial.replyPending)
const statusPending = ref(initial.statusPending)
const noticePending = ref(initial.noticePending)
const failed = ref(initial.failed)
const replyValue = ref(initial.reply)
const notice = ref(initial.notice)
const destinationValue = ref(initial.destination)
const reasonValue = ref(initial.reason)
const needsRefresh = ref(initial.needsRefresh)
const sharedRead = ref(initial.sharedRead)
const activityAvailable = ref(initial.activityAvailable)
const unreadAckFailed = ref(initial.unreadAckFailed)
const noticesEnabled = ref(initial.noticesEnabled)
const composeNoticeValue = ref(initial.composeNotice)
const recipientValue = ref(initial.recipient)
const noticeSubjectValue = ref(initial.noticeSubject)
const noticeBodyValue = ref(initial.noticeBody)

function syncSnapshot(snap: AdminInboxState) {
  if (rows.value !== snap.rows) rows.value = snap.rows
  if (thread.value !== snap.thread) thread.value = snap.thread
  if (next.value !== snap.next) next.value = snap.next
  if (filterValue.value !== snap.filter) filterValue.value = snap.filter
  if (orderValue.value !== snap.order) orderValue.value = snap.order
  if (queuePending.value !== snap.queuePending) {
    queuePending.value = snap.queuePending
    if (!snap.queuePending) queueAction.value = null
  }
  if (threadPending.value !== snap.threadPending) {
    threadPending.value = snap.threadPending
    if (!snap.threadPending) threadAction.value = null
  }
  if (readPending.value !== snap.readPending) readPending.value = snap.readPending
  if (replyPending.value !== snap.replyPending) replyPending.value = snap.replyPending
  if (statusPending.value !== snap.statusPending) statusPending.value = snap.statusPending
  if (noticePending.value !== snap.noticePending) noticePending.value = snap.noticePending
  if (failed.value !== snap.failed) failed.value = snap.failed
  if (replyValue.value !== snap.reply) replyValue.value = snap.reply
  if (notice.value !== snap.notice) notice.value = snap.notice
  if (destinationValue.value !== snap.destination) destinationValue.value = snap.destination
  if (reasonValue.value !== snap.reason) reasonValue.value = snap.reason
  if (needsRefresh.value !== snap.needsRefresh) needsRefresh.value = snap.needsRefresh
  if (sharedRead.value !== snap.sharedRead) sharedRead.value = snap.sharedRead
  if (activityAvailable.value !== snap.activityAvailable) activityAvailable.value = snap.activityAvailable
  if (unreadAckFailed.value !== snap.unreadAckFailed) unreadAckFailed.value = snap.unreadAckFailed
  if (noticesEnabled.value !== snap.noticesEnabled) noticesEnabled.value = snap.noticesEnabled
  if (composeNoticeValue.value !== snap.composeNotice) composeNoticeValue.value = snap.composeNotice
  if (recipientValue.value !== snap.recipient) recipientValue.value = snap.recipient
  if (noticeSubjectValue.value !== snap.noticeSubject) noticeSubjectValue.value = snap.noticeSubject
  if (noticeBodyValue.value !== snap.noticeBody) noticeBodyValue.value = snap.noticeBody
}

const unsubscribe = controller.subscribe(() => {
  syncSnapshot(controller.snapshot())
})

const filter = computed({
  get: () => filterValue.value,
  set: value => controller.setFilter(value),
})
const order = computed({
  get: () => orderValue.value,
  set: value => controller.setOrder(value),
})
const reply = computed({
  get: () => replyValue.value,
  set: value => controller.setReply(value),
})
const destination = computed({
  get: () => destinationValue.value,
  set: value => controller.setDestination(value),
})
const reason = computed({
  get: () => reasonValue.value,
  set: value => controller.setReason(value),
})
const composeNotice = computed({
  get: () => composeNoticeValue.value,
  set: value => controller.setComposeNotice(value),
})
const recipient = computed({
  get: () => recipientValue.value,
  set: value => controller.setRecipient(value),
})
const noticeSubject = computed({
  get: () => noticeSubjectValue.value,
  set: value => controller.setNoticeSubject(value),
})
const noticeBody = computed({
  get: () => noticeBodyValue.value,
  set: value => controller.setNoticeBody(value),
})

const renderedMessages = computed<readonly InboxRenderedMessage[]>(() => {
  const current = thread.value
  if (!current) return []
  const formatter = timeFormat.value
  const internalLabel = t('admin.inbox.m49')
  return current.messages.map(message => ({
    id: String(message.id),
    variant: inboxBubbleVariant(message.sender, 'admin', message.internal),
    author: `${t(senders[message.sender])}${message.internal ? ` · ${internalLabel}` : ''}`,
    meta: formatter.full(message.at),
    body: message.body,
  }))
})

const threadKey = computed(() => {
  const current = thread.value
  if (!current) return ''
  return `${current.conversation.id}-${current.repliesEnabled ? 'r' : 'n'}-${current.version ? 'v' : 'x'}-${current.conversation.status}`
})

function openThread(id: bigint, before: string | null = null, event?: MouseEvent) {
  if (event?.currentTarget instanceof HTMLElement) opener = event.currentTarget
  threadAction.value = before ? 'earlier' : null
  void controller.openThread(id, before)
}

const closeThread = () => controller.closeThread()
const loadQueue = (cursor: string | null = null, action: 'refresh' | 'more' | null = cursor ? 'more' : 'refresh') => {
  queueAction.value = action
  void controller.loadQueue(cursor)
}
const retryRead = () => { void controller.retryRead() }
const clearNotice = () => {
  if (!noticePending.value) controller.clearNotice()
}
const sendNotice = () => { void controller.sendNotice() }
const sendReply = () => { void controller.sendReply() }
const saveStatus = () => { void controller.saveStatus() }
const reloadThread = () => {
  threadAction.value = 'reload'
  void controller.reloadThread()
}

watch(() => props.sessionSignal, signal => {
  controller.bindSession(signal, { autoLoad: true })
}, { flush: 'sync' })

onMounted(() => {
  if (!props.sessionSignal.aborted) loadQueue(null, null)
})

onBeforeUnmount(() => {
  unsubscribe()
  controller.dispose()
})
</script>

<template>
  <section class="inbox-admin" aria-labelledby="admin-inbox-title">
    <h2 id="admin-inbox-title" class="inbox-admin-sr-title">{{ t('admin.inbox.m1') }}</h2>
    <ElAlert v-if="failed && !composeNotice" :title="t(failed)" type="error" :closable="false" show-icon />
    <ElAlert v-if="notice" :title="t(notice)" type="success" :closable="false" show-icon />

    <InboxSplitWorkspace
      ref="workspace"
      :has-selection="Boolean(thread)"
      :has-thread="Boolean(thread)"
      :list-label="t('admin.inbox.m1')"
      :detail-label="t('admin.inbox.m1')"
      :list-busy="queuePending"
      :list-empty="rows.length === 0"
      :list-error="Boolean(failed)"
      :empty-list-title="t('admin.inbox.m21')"
      :has-more="Boolean(next)"
      :more-loading="queueMoreLoading"
      :more-label="t('admin.inbox.m24')"
      :thread-key="threadKey"
      :thread-title="thread?.conversation.subject ?? ''"
      thread-title-tag="h3"
      :thread-busy="threadPending || replyPending || statusPending"
      show-back
      :back-disabled="replyPending || statusPending"
      :back-label="t('admin.inbox.m25')"
      :has-earlier="Boolean(thread?.previous)"
      :earlier-loading="threadEarlierLoading"
      :earlier-label="t('admin.inbox.m29')"
      :messages="renderedMessages"
      :reply-enabled="Boolean(thread && thread.repliesEnabled && thread.conversation.status !== 2)"
      reply-input-id="admin-inbox-reply"
      :reply-label="t('admin.inbox.m33')"
      v-model:reply-model="reply"
      :reply-disabled="replyPending"
      :reply-pending="replyPending"
      :reply-submit-label="t('admin.inbox.m34')"
      :has-composer-extra="Boolean(thread?.version)"
      :empty-selection-title="t('admin.inbox.m1')"
      @load-more="loadQueue(next)"
      @back="closeThread"
      @load-earlier="thread && thread.previous && openThread(thread.conversation.id, thread.previous)"
      @submit-reply="sendReply"
    >
      <template #list-toolbar>
        <div class="inbox-admin-filters">
          <ElSelect v-model="filter" :ariaLabel="t('admin.inbox.m4')">
            <ElOption :label="t('admin.inbox.m5')" value="" />
            <ElOption :label="t('admin.inbox.m6')" value="open" />
            <ElOption :label="t('admin.inbox.m7')" value="pending" />
            <ElOption :label="t('admin.inbox.m8')" value="closed" />
            <ElOption v-if="sharedRead" :label="t('admin.inbox.m9')" value="unread" />
            <ElOption v-if="sharedRead" :label="t('admin.inbox.m10')" value="system" />
          </ElSelect>
          <ElSelect v-if="activityAvailable" v-model="order" :ariaLabel="t('admin.inbox.m11')">
            <ElOption :label="t('admin.inbox.m12')" value="created" />
            <ElOption :label="t('admin.inbox.m13')" value="activity" />
          </ElSelect>
        </div>
        <div class="inbox-admin-toolbar-actions">
          <ElButton text :loading="queueRefreshLoading" @click="loadQueue()">
            {{ t('admin.inbox.m14') }}
          </ElButton>
          <ElButton
            v-if="noticesEnabled"
            type="primary"
            :disabled="noticePending"
            @click="composeNotice = true"
          >{{ t('admin.inbox.m15') }}</ElButton>
        </div>
      </template>

      <template #list-items>
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
            @click="openThread(item.id, null, $event)"
          >{{ item.subject }}</button>
          <div class="inbox-admin-item-meta">
            <ElTag size="small" :type="inboxStatusTagType(item.status)" disable-transitions>
              {{ t(statuses[item.status]) }}
            </ElTag>
            <small>{{ t(item.system ? 'admin.inbox.m22' : 'admin.inbox.m23') }}</small>
            <small v-if="item.unread" class="inbox-admin-unread">
              {{ t('admin.inbox.m47', { count: item.unread }) }}
            </small>
            <small class="inbox-admin-time">{{ timeFormat.compact(item.updated) }}</small>
          </div>
        </div>
      </template>

      <template #thread-actions>
        <ElButton
          v-if="thread && (thread.version || thread.liveEnabled || needsRefresh)"
          text
          :loading="threadReloadLoading"
          @click="reloadThread"
        >{{ t('admin.inbox.m26') }}</ElButton>
      </template>

      <template v-if="thread" #thread-context>
        <ElTag size="small" :type="inboxStatusTagType(thread.conversation.status)" disable-transitions>
          {{ t(statuses[thread.conversation.status]) }}
        </ElTag>
        <span>{{ t(thread.conversation.system ? 'admin.inbox.m22' : 'admin.inbox.m23') }}</span>
        <span class="inbox-admin-account">{{ t('admin.inbox.m48', { account: thread.conversation.account }) }}</span>
        <ElTag v-if="thread.conversation.unread" size="small" disable-transitions>
          {{ t('admin.inbox.m47', { count: thread.conversation.unread }) }}
        </ElTag>
      </template>

      <template v-if="unreadAckFailed" #thread-context-extra>
        <div class="inbox-admin-alert-row">
          <ElAlert :title="t('admin.inbox.m27')" type="warning" :closable="false" show-icon />
          <ElButton :loading="readPending" @click="retryRead">{{ t('admin.inbox.m28') }}</ElButton>
        </div>
      </template>

      <template v-if="thread?.version" #composer-extra>
        <form class="inbox-admin-status-form" @submit.prevent="saveStatus">
          <div class="inbox-admin-field inbox-admin-status-select">
            <span class="inbox-admin-field-label" aria-hidden="true">{{ t('admin.inbox.m35') }}</span>
            <ElSelect v-model="destination" :ariaLabel="t('admin.inbox.m35')" :placeholder="t('admin.inbox.m36')" :disabled="statusPending">
              <ElOption v-for="option in transitions[thread.conversation.status]" :key="option" :label="t(statuses[option])" :value="option" />
            </ElSelect>
          </div>
          <div class="inbox-admin-field inbox-admin-status-reason">
            <label for="admin-inbox-status-reason">{{ t('admin.inbox.m37') }}</label>
            <ElInput id="admin-inbox-status-reason" v-model="reason" :disabled="statusPending" />
          </div>
          <div class="inbox-admin-status-actions">
            <ElButton
              native-type="submit"
              :loading="statusPending"
              :disabled="replyPending || destination === undefined || !reason.trim() || reason.trim().length > 256"
            >{{ t('admin.inbox.m38') }}</ElButton>
          </div>
        </form>
      </template>
    </InboxSplitWorkspace>

    <ElDialog
      v-if="noticesEnabled"
      :model-value="composeNotice"
      :title="t('admin.inbox.m15')"
      :append-to-body="false"
      width="min(32rem, calc(100vw - 2rem))"
      :close-on-press-escape="!noticePending"
      :close-on-click-modal="!noticePending"
      :show-close="!noticePending"
      @update:model-value="open => { if (!open) clearNotice() }"
    >
      <form id="admin-inbox-notice-form" class="inbox-admin-notice-form" @submit.prevent="sendNotice">
        <ElAlert v-if="failed" :title="t(failed)" type="error" :closable="false" show-icon />
        <div class="inbox-admin-field">
          <label for="admin-notice-account">{{ t('admin.inbox.m16') }}</label>
          <ElInput id="admin-notice-account" v-model="recipient" :disabled="noticePending" />
        </div>
        <div class="inbox-admin-field">
          <label for="admin-notice-subject">{{ t('admin.inbox.m17') }}</label>
          <ElInput id="admin-notice-subject" v-model="noticeSubject" :disabled="noticePending" />
        </div>
        <div class="inbox-admin-field">
          <label for="admin-notice-body">{{ t('admin.inbox.m18') }}</label>
          <ElInput
            id="admin-notice-body"
            v-model="noticeBody"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :disabled="noticePending"
          />
        </div>
      </form>
      <template #footer>
        <ElInlineActions density="compact">
          <ElButton :disabled="noticePending" @click="clearNotice">
            {{ t('admin.inbox.m20') }}
          </ElButton>
          <ElButton
            native-type="submit"
            type="primary"
            v-bind="{ form: 'admin-inbox-notice-form' }"
            :loading="noticePending"
            :disabled="!isNoticeRecipient(recipient.trim()) || !noticeBody.trim()"
          >{{ t('admin.inbox.m19') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.inbox-admin {
  display: grid;
  gap: var(--fsus-space-3);
  min-inline-size: 0;
}

.inbox-admin-sr-title {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.inbox-admin-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--fsus-space-2);
}

.inbox-admin-toolbar-actions,
.inbox-admin-status-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-2);
  align-items: safe center;
}

.inbox-admin-toolbar-actions {
  justify-content: space-between;
}

.inbox-admin-notice-form {
  display: grid;
  gap: var(--fsus-space-4);
}

.inbox-admin-status-form {
  display: grid;
  gap: 10px;
  padding: 10px 12px;
  border-block-start: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}

.inbox-admin-field {
  display: grid;
  gap: 6px;
  min-inline-size: 0;
}

.inbox-admin-field label,
.inbox-admin-field-label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
  line-height: 1.4;
}

.inbox-admin-item {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  background: transparent;
  transition: background-color 140ms ease, box-shadow 140ms ease;
}

.inbox-admin-item + .inbox-admin-item {
  border-block-start: 1px solid var(--el-border-color-lighter);
}

.inbox-admin-item:hover {
  background: var(--el-fill-color-light);
}

.inbox-admin-item.is-selected {
  box-shadow: inset 3px 0 0 var(--fsus-scholarly-blue, #2a599c);
  background: var(--fsus-state-selected-bg, var(--el-fill-color-light));
}

.inbox-admin-subject {
  display: block;
  inline-size: 100%;
  min-block-size: 44px;
  padding-block: 6px;
  padding-inline: 0;
  border: 0;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: var(--el-font-size-base);
  font-weight: 700;
  line-height: 1.35;
  text-align: start;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.inbox-admin-subject:focus-visible {
  outline: 2px solid var(--fsus-scholarly-blue, #2a599c);
  outline-offset: 2px;
  border-radius: var(--fsus-radius-control-small, 4px);
}

.inbox-admin-item-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: safe center;
  gap: var(--fsus-space-2);
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-extra-small);
}

.inbox-admin-unread {
  color: var(--fsus-scholarly-blue, #2a599c);
  font-weight: 600;
}

.inbox-admin-time {
  margin-inline-start: auto;
  font-variant-numeric: tabular-nums;
}

.inbox-admin-alert-row {
  display: grid;
  gap: var(--fsus-space-2);
  padding: 8px 16px 12px;
}

.inbox-admin-account {
  overflow-wrap: anywhere;
}

@container inbox-composer (inline-size >= 34rem) {
  .inbox-admin-status-form {
    grid-template-columns: minmax(9.5rem, 11rem) minmax(0, 1fr) auto;
    align-items: end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .inbox-admin-item {
    transition: none;
  }
}
</style>
