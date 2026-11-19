<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  ElAlert, ElButton, ElConversationContextBar, ElConversationList, ElEmptySelectionState,
  ElInboxEmptyState, ElInboxLayout, ElInput, ElMessageBubble, ElMessageTimeline,
  ElOption, ElReplyComposerShell, ElSelect, ElSkeleton, ElTag, ElThreadPanel,
} from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { adminSendNotice, isNoticeRecipient, newNoticeEventId } from '../../../Contracts/admin-inbox-notice'
import { acknowledgeAdminInboxRead, adminChangeStatus, adminInbox, adminInboxThread, adminReply,
  supportsAdminInboxLiveStatus, watchAdminInboxWake, type AdminInboxFilter, type AdminInboxLiveStatus,
  type AdminInboxOrder, type AdminInboxPage, type AdminInboxRow,
  type AdminInboxStatus, type AdminInboxThread } from '../../../Contracts/admin-inbox'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: unknown] }>()
const rows = shallowRef<AdminInboxRow[]>([])
const thread = shallowRef<AdminInboxThread>()
const next = ref<string | null>(null)
const filter = ref<AdminInboxFilter>('')
const order = ref<AdminInboxOrder>('created')
const expanded = ref(true)
const pending = ref(false)
const failed = ref<MessageKey | ''>('')
const title = ref<HTMLElement>()
const threadPanel = ref<HTMLElement>()
const queue = ref<HTMLElement>()
const reply = ref('')
const notice = ref<MessageKey | ''>('')
const destination = ref<AdminInboxStatus>()
const reason = ref('')
const needsRefresh = ref(false)
const sharedRead = ref(false)
const activityAvailable = ref(false)
const queueLive = ref(false)
const unreadAckFailed = ref(false)
const noticesEnabled = ref(false)
const composeNotice = ref(false)
const recipient = ref('')
const noticeSubject = ref('')
const noticeBody = ref('')
const statuses = ['admin.inbox.m6', 'admin.inbox.m7', 'admin.inbox.m8'] as const
const statusFilters = ['open', 'pending', 'closed'] as const
const transitions: readonly (readonly AdminInboxStatus[])[] = [[1, 2], [0, 2], [0]]
const senders = ['admin.inbox.m30', 'admin.inbox.m31', 'admin.inbox.m32'] as const
const statusTagTypes = ['', 'warning', 'info'] as const

function statusTagType(status: AdminInboxStatus) {
  return statusTagTypes[status]
}

function messageVariant(message: AdminInboxThread['messages'][number]): 'other' | 'self' | 'system' | 'muted' {
  if (message.internal) return 'muted'
  if (message.sender === 1) return 'self'
  if (message.sender === 2) return 'system'
  return 'other'
}
let operation = new AbortController()
let opener: HTMLElement | undefined
let attempt: { conversation: bigint; body: string; key: string } | undefined
let noticeAttempt: { account: string; subject: string; body: string; eventId: bigint } | undefined

function reset() {
  operation.abort()
  operation = new AbortController()
  rows.value = []
  thread.value = undefined
  next.value = null
  failed.value = ''
  pending.value = false
  opener = undefined
  clearReply()
  clearStatus()
  clearNotice()
  noticesEnabled.value = false
  sharedRead.value = false
  activityAvailable.value = false
  queueLive.value = false
  unreadAckFailed.value = false
}

function closeThread() {
  thread.value = undefined
  unreadAckFailed.value = false
  clearReply()
  clearStatus()
  void nextTick(() => { if (opener?.isConnected) opener.focus() })
}

async function read(load: (signal: AbortSignal) => Promise<void>, message: MessageKey = 'admin.inbox.m39') {
  if (pending.value || props.sessionSignal.aborted) return
  const signal = AbortSignal.any([props.sessionSignal, operation.signal])
  pending.value = true
  failed.value = ''
  try { await load(signal) }
  catch (error) {
    if (signal.aborted) return
    if (!(error instanceof ApiError && error.details.startsWith('pow_'))) emit('sessionLost', error)
    failed.value = message
  } finally { if (!signal.aborted) pending.value = false }
}

function loadQueue(cursor: string | null = null) {
  void read(async signal => {
    let page = await adminInbox(filter.value, cursor, signal, sharedRead.value, order.value)
    if (!cursor && !sharedRead.value && page.sharedAvailable)
      page = await adminInbox(filter.value, null, signal, true, order.value)
    if (signal.aborted) return
    applyQueuePage(page, cursor !== null)
  })
}

function applyQueuePage(page: AdminInboxPage, append = false) {
  rows.value = append ? [...rows.value, ...page.rows] : page.rows
  next.value = page.next
  noticesEnabled.value = page.noticesEnabled
  sharedRead.value = page.sharedAvailable
  activityAvailable.value = page.activityAvailable
  queueLive.value = !append && page.liveEnabled
}

function openThread(id: bigint, before: string | null = null, event?: MouseEvent) {
  if (event?.currentTarget instanceof HTMLElement) opener = event.currentTarget
  void read(async signal => {
    const page = await adminInboxThread(id, before, signal, sharedRead.value)
    if (signal.aborted) return
    thread.value = before && thread.value?.conversation.id === id
      ? { ...page, messages: [...page.messages, ...thread.value.messages], readSnapshot: thread.value.readSnapshot } : page
    if (!before) {
      clearStatus()
      await nextTick()
      title.value?.focus()
      await acknowledge(id, signal)
    }
  })
}

async function acknowledge(id: bigint, signal: AbortSignal) {
  const seen = thread.value
  if (signal.aborted || seen?.conversation.id !== id || !seen.readSnapshot) return
  unreadAckFailed.value = false
  try {
    const unread = await acknowledgeAdminInboxRead(id, seen.readSnapshot, signal)
    if (signal.aborted || thread.value?.readSnapshot !== seen.readSnapshot) return
    const updated = { ...seen.conversation, unread }
    thread.value = { ...seen, conversation: updated, readSnapshot: null }
    rows.value = filter.value === 'unread' && unread === 0
      ? rows.value.filter(item => item.id !== id)
      : rows.value.map(item => item.id === id ? { ...item, unread } : item)
  } catch (error) {
    if (signal.aborted) return
    emit('sessionLost', error)
    unreadAckFailed.value = true
  }
}

function retryRead() {
  const current = thread.value
  if (current) void read(signal => acknowledge(current.conversation.id, signal))
}

function clearReply() {
  reply.value = ''
  notice.value = ''
  attempt = undefined
}

function clearStatus() {
  destination.value = undefined
  reason.value = ''
  needsRefresh.value = false
}

function clearNotice() {
  composeNotice.value = false
  recipient.value = ''
  noticeSubject.value = ''
  noticeBody.value = ''
  noticeAttempt = undefined
}

function sendNotice() {
  const account = recipient.value.trim().toLowerCase()
  const subject = noticeSubject.value
  const body = noticeBody.value
  if (!noticesEnabled.value || !isNoticeRecipient(account) || !body.trim() || pending.value) return
  if (noticeAttempt?.account !== account || noticeAttempt.subject !== subject || noticeAttempt.body !== body)
    noticeAttempt = { account, subject, body, eventId: newNoticeEventId() }
  const eventId = noticeAttempt.eventId
  notice.value = ''
  void read(async signal => {
    await adminSendNotice(account, subject, body, eventId, signal)
    if (signal.aborted) return
    clearNotice()
    notice.value = 'admin.inbox.m40'
    const page = await adminInbox(filter.value, null, signal, sharedRead.value, order.value)
    if (!signal.aborted) applyQueuePage(page)
  }, 'admin.inbox.m41')
}

function applyLatestThread(latest: AdminInboxThread, keepReadSnapshot = false) {
  const current = thread.value
  if (current?.conversation.id !== latest.conversation.id) return false
  const focus = document.activeElement
  const focusedInThread = focus && threadPanel.value?.contains(focus)
  const first = latest.messages[0].id
  // Keep the earlier pages only when the newest authoritative page still joins them.
  const overlap = current.messages.findIndex(message => message.id === first)
  thread.value = {
    ...latest,
    previous: overlap > 0 ? current.previous : latest.previous,
    messages: overlap > 0 ? [...current.messages.slice(0, overlap), ...latest.messages] : latest.messages,
    readSnapshot: keepReadSnapshot ? current.readSnapshot : latest.readSnapshot,
  }
  if (destination.value !== undefined && !transitions[latest.conversation.status].includes(destination.value))
    destination.value = undefined
  if (focusedInThread) {
    void nextTick(() => {
      if (!props.sessionSignal.aborted && thread.value?.conversation.id === latest.conversation.id &&
          !focus.isConnected && document.activeElement === document.body) title.value?.focus()
    })
  }
  needsRefresh.value = false
  return true
}

async function refreshThread(id: bigint, signal: AbortSignal) {
  const latest = await adminInboxThread(id, null, signal, sharedRead.value)
  if (signal.aborted || !applyLatestThread(latest)) return
  await nextTick()
  await acknowledge(id, signal)
}

function sendReply() {
  const current = thread.value
  if (!current || current.conversation.status === 2 || !current.repliesEnabled || !reply.value.trim() || pending.value) return
  const conversation = current.conversation.id
  const body = reply.value
  if (attempt?.conversation !== conversation || attempt.body !== body) attempt = { conversation, body, key: crypto.randomUUID() }
  const key = attempt.key
  notice.value = ''
  void read(async signal => {
    const saved = await adminReply(conversation, body, key, signal)
    if (signal.aborted) return
    const messages = current.messages.some(message => message.id === saved.id) ? current.messages :
      [...current.messages, { id: saved.id, sender: 1 as const, internal: false, at: saved.createdAt, body: saved.body }]
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    thread.value = { ...current, messages, version: null }
    clearReply()
    notice.value = 'admin.inbox.m42'
    if (current.version) {
      needsRefresh.value = true
      await refreshThread(conversation, signal)
    }
  }, 'admin.inbox.m43')
}

function saveStatus() {
  const current = thread.value
  const target = destination.value
  if (!current?.version || target === undefined || !transitions[current.conversation.status].includes(target) ||
      !reason.value.trim() || reason.value.trim().length > 256) return
  const conversation = current.conversation.id
  const version = current.version
  const explanation = reason.value
  notice.value = ''
  void read(async signal => {
    const saved = await adminChangeStatus(conversation, version, target, explanation, signal)
    if (signal.aborted) return
    const updated = { ...current.conversation, status: saved.current }
    thread.value = { ...current, conversation: updated, version: null }
    rows.value = statusFilters.some(status => status === filter.value) && filter.value !== statusFilters[saved.current]
      ? rows.value.filter(item => item.id !== conversation)
      : rows.value.map(item => item.id === conversation ? updated : item)
    clearStatus()
    notice.value = saved.changed ? 'admin.inbox.m44' : 'admin.inbox.m45'
    needsRefresh.value = true
    await refreshThread(conversation, signal)
  }, 'admin.inbox.m46')
}

function reloadThread() {
  const current = thread.value
  if (current) void read(signal => refreshThread(current.conversation.id, signal))
}

function toggle() {
  expanded.value = !expanded.value
  filter.value = ''
  order.value = 'created'
  reset()
  if (expanded.value) loadQueue()
}

function liveScope(): bigint | AdminInboxLiveStatus | undefined {
  const current = thread.value
  if (current) return current.liveEnabled ? current.conversation.id : undefined
  const status = filter.value
  return expanded.value && queueLive.value && order.value === 'created' && supportsAdminInboxLiveStatus(status)
    ? status : undefined
}

watch([filter, order], () => {
  if (!expanded.value) return
  const shared = sharedRead.value
  const activity = activityAvailable.value
  reset()
  sharedRead.value = shared
  activityAvailable.value = activity
  loadQueue()
})
watch(() => props.sessionSignal, signal => {
  expanded.value = !signal.aborted
  filter.value = ''
  order.value = 'created'
  reset()
  if (!signal.aborted) loadQueue()
}, { flush: 'sync' })
onMounted(() => {
  if (expanded.value && !props.sessionSignal.aborted) loadQueue()
})
watch(liveScope, (value, _, onCleanup) => {
  if (value === undefined) return
  const target = value
  const scope = new AbortController()
  const signal = AbortSignal.any([props.sessionSignal, operation.signal, scope.signal])
  let dirty = false
  let refreshing = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let delay = 1_000

  async function refresh() {
    if (signal.aborted || liveScope() !== target || !dirty || refreshing || pending.value || retry !== undefined) return
    dirty = false
    refreshing = true
    try {
      if (typeof target === 'string') {
        const previous = rows.value
        const page = await adminInbox(target, null, signal, sharedRead.value)
        if (signal.aborted || liveScope() !== target) return
        if (pending.value || previous !== rows.value) dirty = true
        else {
          const focus = document.activeElement
          applyQueuePage(page)
          if (focus && queue.value?.contains(focus)) {
            void nextTick(() => {
              if (!signal.aborted && !focus.isConnected && document.activeElement === document.body) queue.value?.focus()
            })
          }
        }
      } else {
        const previous = thread.value
        const snapshot = await adminInboxThread(target, null, signal, sharedRead.value)
        if (signal.aborted || liveScope() !== target) return
        if (pending.value || previous !== thread.value) dirty = true
        else applyLatestThread(snapshot, unreadAckFailed.value)
      }
      delay = 1_000
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof ApiError && error.status === 401) {
        emit('sessionLost', error)
      } else if (!(error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429)) {
        dirty = true
        retry = setTimeout(() => { retry = undefined; void refresh() }, delay)
        delay = Math.min(delay * 2, 16_000)
      }
    } finally {
      refreshing = false
      if (dirty) void refresh()
    }
  }

  function wake() { dirty = true; void refresh() }
  const resume = watch(pending, () => { void refresh() })
  onCleanup(() => {
    scope.abort()
    clearTimeout(retry)
    resume()
  })
  watchAdminInboxWake(target, signal, wake, () => emit('sessionLost', new ApiError('Administrator session expired.', 401)))
})
onBeforeUnmount(() => operation.abort())
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
