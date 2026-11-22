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
} from '../admin/adminInboxController'
import { snapshotFields } from '../authoring/snapshotFields'
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
          if (!props.sessionSignal.aborted && state.thread?.conversation.id === conversationId &&
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

const queueAction = ref<'refresh' | 'more' | null>(null)
const threadAction = ref<'reload' | 'earlier' | null>(null)
const { state, update } = snapshotFields({
  rows: shallowRef(initial.rows),
  thread: shallowRef(initial.thread),
  next: ref(initial.next),
  filter: ref(initial.filter),
  order: ref(initial.order),
  queuePending: ref(initial.queuePending),
  threadPending: ref(initial.threadPending),
  readPending: ref(initial.readPending),
  replyPending: ref(initial.replyPending),
  statusPending: ref(initial.statusPending),
  noticePending: ref(initial.noticePending),
  failed: ref(initial.failed),
  reply: ref(initial.reply),
  notice: ref(initial.notice),
  destination: ref(initial.destination),
  reason: ref(initial.reason),
  needsRefresh: ref(initial.needsRefresh),
  sharedRead: ref(initial.sharedRead),
  activityAvailable: ref(initial.activityAvailable),
  unreadAckFailed: ref(initial.unreadAckFailed),
  noticesEnabled: ref(initial.noticesEnabled),
  composeNotice: ref(initial.composeNotice),
  recipient: ref(initial.recipient),
  noticeSubject: ref(initial.noticeSubject),
  noticeBody: ref(initial.noticeBody),
}, key => {
  if (key === 'queuePending' && !state.queuePending) queueAction.value = null
  if (key === 'threadPending' && !state.threadPending) threadAction.value = null
})
const queueRefreshLoading = useDelayedBusy(() => state.queuePending && queueAction.value === 'refresh')
const queueMoreLoading = useDelayedBusy(() => state.queuePending && queueAction.value === 'more')
const threadReloadLoading = useDelayedBusy(() => state.threadPending && threadAction.value === 'reload')
const threadEarlierLoading = useDelayedBusy(() => state.threadPending && threadAction.value === 'earlier')

const unsubscribe = controller.subscribe(() => update(controller.snapshot()))

function bind<K extends keyof typeof state>(key: K, write: (value: (typeof state)[K]) => void) {
  return computed({ get: () => state[key], set: write })
}
const filter = bind('filter', value => controller.setFilter(value))
const order = bind('order', value => controller.setOrder(value))
const reply = bind('reply', value => controller.setReply(value))
const destination = bind('destination', value => controller.setDestination(value))
const reason = bind('reason', value => controller.setReason(value))
const composeNotice = bind('composeNotice', value => controller.setComposeNotice(value))
const recipient = bind('recipient', value => controller.setRecipient(value))
const noticeSubject = bind('noticeSubject', value => controller.setNoticeSubject(value))
const noticeBody = bind('noticeBody', value => controller.setNoticeBody(value))

const renderedMessages = computed<readonly InboxRenderedMessage[]>(() => {
  const current = state.thread
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
  const current = state.thread
  if (!current) return ''
  const closed = current.conversation.status === 2
  return `${current.conversation.id}-${current.repliesEnabled ? 'r' : 'n'}-${current.version ? 'v' : 'x'}-${closed}`
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
  if (!state.noticePending) controller.clearNotice()
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
    <ElAlert v-if="state.failed && !composeNotice" :title="t(state.failed)" type="error" :closable="false" show-icon />
    <ElAlert v-if="state.notice" :title="t(state.notice)" type="success" :closable="false" show-icon />

    <InboxSplitWorkspace
      ref="workspace"
      :has-selection="Boolean(state.thread)"
      :has-thread="Boolean(state.thread)"
      :list-label="t('admin.inbox.m1')"
      :detail-label="t('admin.inbox.m1')"
      :list-busy="state.queuePending"
      :list-empty="state.rows.length === 0"
      :list-error="Boolean(state.failed)"
      :empty-list-title="t('admin.inbox.m21')"
      :has-more="Boolean(state.next)"
      :more-loading="queueMoreLoading"
      :more-label="t('admin.inbox.m24')"
      :thread-key="threadKey"
      :thread-title="state.thread?.conversation.subject ?? ''"
      thread-title-tag="h3"
      :thread-busy="state.threadPending || state.replyPending || state.statusPending"
      show-back
      :back-disabled="state.replyPending || state.statusPending"
      :back-label="t('admin.inbox.m25')"
      :has-earlier="Boolean(state.thread?.previous)"
      :earlier-loading="threadEarlierLoading"
      :earlier-label="t('admin.inbox.m29')"
      :messages="renderedMessages"
      :reply-enabled="Boolean(state.thread && state.thread.repliesEnabled && state.thread.conversation.status !== 2)"
      reply-input-id="admin-inbox-reply"
      :reply-label="t('admin.inbox.m33')"
      v-model:reply-model="reply"
      :reply-disabled="state.replyPending"
      :reply-pending="state.replyPending"
      :reply-submit-label="t('admin.inbox.m34')"
      :has-composer-extra="Boolean(state.thread?.version)"
      :empty-selection-title="t('admin.inbox.m1')"
      @load-more="loadQueue(state.next)"
      @back="closeThread"
      @load-earlier="state.thread && state.thread.previous && openThread(state.thread.conversation.id, state.thread.previous)"
      @submit-reply="sendReply"
    >
      <template #list-toolbar>
        <div class="inbox-admin-filters">
          <ElSelect v-model="filter" :ariaLabel="t('admin.inbox.m4')">
            <ElOption :label="t('admin.inbox.m5')" value="" />
            <ElOption :label="t('admin.inbox.m6')" value="open" />
            <ElOption :label="t('admin.inbox.m7')" value="pending" />
            <ElOption :label="t('admin.inbox.m8')" value="closed" />
            <ElOption v-if="state.sharedRead" :label="t('admin.inbox.m9')" value="unread" />
            <ElOption v-if="state.sharedRead" :label="t('admin.inbox.m10')" value="system" />
          </ElSelect>
          <ElSelect v-if="state.activityAvailable" v-model="order" :ariaLabel="t('admin.inbox.m11')">
            <ElOption :label="t('admin.inbox.m12')" value="created" />
            <ElOption :label="t('admin.inbox.m13')" value="activity" />
          </ElSelect>
        </div>
        <div class="inbox-admin-toolbar-actions">
          <ElButton text :loading="queueRefreshLoading" @click="loadQueue()">
            {{ t('admin.inbox.m14') }}
          </ElButton>
          <ElButton
            v-if="state.noticesEnabled"
            type="primary"
            :disabled="state.noticePending"
            @click="composeNotice = true"
          >{{ t('admin.inbox.m15') }}</ElButton>
        </div>
      </template>

      <template #list-items>
        <div
          v-for="item in state.rows"
          :key="String(item.id)"
          class="inbox-admin-item"
          :class="{ 'is-selected': state.thread?.conversation.id === item.id }"
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
          v-if="state.thread && (state.thread.version || state.thread.liveEnabled || state.needsRefresh)"
          text
          :loading="threadReloadLoading"
          @click="reloadThread"
        >{{ t('admin.inbox.m26') }}</ElButton>
      </template>

      <template v-if="state.thread" #thread-context>
        <ElTag size="small" :type="inboxStatusTagType(state.thread.conversation.status)" disable-transitions>
          {{ t(statuses[state.thread.conversation.status]) }}
        </ElTag>
        <span>{{ t(state.thread.conversation.system ? 'admin.inbox.m22' : 'admin.inbox.m23') }}</span>
        <span class="inbox-admin-account">{{ t('admin.inbox.m48', { account: state.thread.conversation.account }) }}</span>
        <ElTag v-if="state.thread.conversation.unread" size="small" disable-transitions>
          {{ t('admin.inbox.m47', { count: state.thread.conversation.unread }) }}
        </ElTag>
      </template>

      <template v-if="state.unreadAckFailed" #thread-context-extra>
        <div class="inbox-admin-alert-row">
          <ElAlert :title="t('admin.inbox.m27')" type="warning" :closable="false" show-icon />
          <ElButton :loading="state.readPending" @click="retryRead">{{ t('admin.inbox.m28') }}</ElButton>
        </div>
      </template>

      <template v-if="state.thread?.version" #composer-extra>
        <form class="inbox-admin-status-form" @submit.prevent="saveStatus">
          <div class="inbox-admin-field inbox-admin-status-select">
            <span class="inbox-admin-field-label" aria-hidden="true">{{ t('admin.inbox.m35') }}</span>
            <ElSelect v-model="destination" :ariaLabel="t('admin.inbox.m35')" :placeholder="t('admin.inbox.m36')" :disabled="state.statusPending">
              <ElOption v-for="option in transitions[state.thread.conversation.status]" :key="option" :label="t(statuses[option])" :value="option" />
            </ElSelect>
          </div>
          <div class="inbox-admin-field inbox-admin-status-reason">
            <label for="admin-inbox-status-reason">{{ t('admin.inbox.m37') }}</label>
            <ElInput id="admin-inbox-status-reason" v-model="reason" :disabled="state.statusPending" />
          </div>
          <div class="inbox-admin-status-actions">
            <ElButton
              native-type="submit"
              :loading="state.statusPending"
              :disabled="state.replyPending || destination === undefined || !reason.trim() || reason.trim().length > 256"
            >{{ t('admin.inbox.m38') }}</ElButton>
          </div>
        </form>
      </template>
    </InboxSplitWorkspace>

    <ElDialog
      v-if="state.noticesEnabled"
      :model-value="composeNotice"
      :title="t('admin.inbox.m15')"
      :append-to-body="false"
      width="min(32rem, calc(100vw - 2rem))"
      :close-on-press-escape="!state.noticePending"
      :close-on-click-modal="!state.noticePending"
      :show-close="!state.noticePending"
      @update:model-value="open => { if (!open) clearNotice() }"
    >
      <form id="admin-inbox-notice-form" class="inbox-admin-notice-form" @submit.prevent="sendNotice">
        <ElAlert v-if="state.failed" :title="t(state.failed)" type="error" :closable="false" show-icon />
        <div class="inbox-admin-field">
          <label for="admin-notice-account">{{ t('admin.inbox.m16') }}</label>
          <ElInput id="admin-notice-account" v-model="recipient" :disabled="state.noticePending" />
        </div>
        <div class="inbox-admin-field">
          <label for="admin-notice-subject">{{ t('admin.inbox.m17') }}</label>
          <ElInput id="admin-notice-subject" v-model="noticeSubject" :disabled="state.noticePending" />
        </div>
        <div class="inbox-admin-field">
          <label for="admin-notice-body">{{ t('admin.inbox.m18') }}</label>
          <ElInput
            id="admin-notice-body"
            v-model="noticeBody"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :disabled="state.noticePending"
          />
        </div>
      </form>
      <template #footer>
        <ElInlineActions density="compact">
          <ElButton :disabled="state.noticePending" @click="clearNotice">
            {{ t('admin.inbox.m20') }}
          </ElButton>
          <ElButton
            native-type="submit"
            type="primary"
            v-bind="{ form: 'admin-inbox-notice-form' }"
            :loading="state.noticePending"
            :disabled="!isNoticeRecipient(recipient.trim()) || !noticeBody.trim()"
          >{{ t('admin.inbox.m19') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped lang="scss">
@use '../shared-fields' as fields;

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

  @include fields.account-field;
}

.inbox-admin-field label,
.inbox-admin-field-label {

  @include fields.account-label;
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
