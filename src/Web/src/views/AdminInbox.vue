<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
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
const expanded = ref(false)
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
watch(() => props.sessionSignal, () => { expanded.value = false; filter.value = ''; order.value = 'created'; reset() }, { flush: 'sync' })
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
  <section class="auth-form inbox-admin" aria-labelledby="admin-inbox-title">
    <h2 id="admin-inbox-title">{{ t('admin.inbox.m1') }}</h2>
    <ElButton native-type="button" @click="toggle">{{ t(expanded ? 'admin.inbox.m2' : 'admin.inbox.m3') }}</ElButton>
    <template v-if="expanded">
      <ElAlert v-if="failed" :title="t(failed)" type="error" :closable="false" />
      <div v-show="!thread" ref="queue" class="inbox-admin-queue" tabindex="-1" :aria-busy="pending">
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
        <ElButton native-type="button" text :loading="pending" @click="loadQueue()">{{ t('admin.inbox.m14') }}</ElButton>
        <ElButton v-if="noticesEnabled && !composeNotice" native-type="button" :disabled="pending"
          @click="composeNotice = true">{{ t('admin.inbox.m15') }}</ElButton>
        <form v-if="noticesEnabled && composeNotice" class="inbox-admin-reply" @submit.prevent="sendNotice">
          <label for="admin-notice-account">{{ t('admin.inbox.m16') }}</label>
          <ElInput id="admin-notice-account" v-model="recipient" :disabled="pending" />
          <label for="admin-notice-subject">{{ t('admin.inbox.m17') }}</label>
          <ElInput id="admin-notice-subject" v-model="noticeSubject" :disabled="pending" />
          <label for="admin-notice-body">{{ t('admin.inbox.m18') }}</label>
          <ElInput id="admin-notice-body" v-model="noticeBody" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :disabled="pending" />
          <div class="inbox-admin-notice-actions">
            <ElButton native-type="submit" type="primary" :loading="pending"
              :disabled="!isNoticeRecipient(recipient.trim()) || !noticeBody.trim()">{{ t('admin.inbox.m19') }}</ElButton>
            <ElButton native-type="button" :disabled="pending" @click="clearNotice">{{ t('admin.inbox.m20') }}</ElButton>
          </div>
        </form>
        <p v-if="!pending && !failed && rows.length === 0">{{ t('admin.inbox.m21') }}</p>
        <ul v-if="rows.length" class="inbox-admin-list">
          <li v-for="item in rows" :key="String(item.id)">
            <button type="button" class="inbox-admin-subject" :disabled="pending" @click="openThread(item.id, null, $event)">{{ item.subject }}</button>
            <small>{{ t(statuses[item.status]) }} · {{ t(item.system ? 'admin.inbox.m22' : 'admin.inbox.m23') }}</small>
            <small v-if="item.unread">{{ t('admin.inbox.m47', { count: item.unread }) }}</small>
          </li>
        </ul>
        <ElButton v-if="next" native-type="button" text :disabled="pending" @click="loadQueue(next)">{{ t('admin.inbox.m24') }}</ElButton>
      </div>
      <section v-if="thread" ref="threadPanel" aria-labelledby="admin-inbox-thread" :aria-busy="pending">
        <ElButton native-type="button" text :disabled="pending" @click="closeThread">{{ t('admin.inbox.m25') }}</ElButton>
        <ElButton v-if="thread.version || thread.liveEnabled || needsRefresh" native-type="button" text :disabled="pending"
          @click="reloadThread">{{ t('admin.inbox.m26') }}</ElButton>
        <h3 id="admin-inbox-thread" ref="title" tabindex="-1">{{ thread.conversation.subject }}</h3>
        <p>{{ t(statuses[thread.conversation.status]) }} · {{ t(thread.conversation.system ? 'admin.inbox.m22' : 'admin.inbox.m23') }}</p>
        <p class="inbox-admin-account">{{ t('admin.inbox.m48', { account: thread.conversation.account }) }}</p>
        <p v-if="thread.conversation.unread">{{ t('admin.inbox.m47', { count: thread.conversation.unread }) }}</p>
        <template v-if="unreadAckFailed">
          <ElAlert :title="t('admin.inbox.m27')" type="warning" :closable="false" />
          <ElButton native-type="button" :disabled="pending" @click="retryRead">{{ t('admin.inbox.m28') }}</ElButton>
        </template>
        <ElButton v-if="thread.previous" native-type="button" text :disabled="pending"
          @click="openThread(thread.conversation.id, thread.previous)">{{ t('admin.inbox.m29') }}</ElButton>
        <ol class="inbox-admin-list">
          <li v-for="message in thread.messages" :key="String(message.id)">
            <small>{{ t(senders[message.sender]) }}<template v-if="message.internal"> · {{ t('admin.inbox.m49') }}</template> · {{ new Date(message.at).toLocaleString() }}</small>
            <p class="inbox-admin-body">{{ message.body }}</p>
          </li>
        </ol>
        <form v-if="thread.repliesEnabled && thread.conversation.status !== 2" class="inbox-admin-reply" @submit.prevent="sendReply">
          <label for="admin-inbox-reply">{{ t('admin.inbox.m33') }}</label>
          <ElInput id="admin-inbox-reply" v-model="reply" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :disabled="pending" />
          <ElButton native-type="submit" type="primary" :loading="pending" :disabled="!reply.trim()">{{ t('admin.inbox.m34') }}</ElButton>
        </form>
        <form v-if="thread.version" class="inbox-admin-reply" @submit.prevent="saveStatus">
          <ElSelect v-model="destination" :ariaLabel="t('admin.inbox.m35')" :placeholder="t('admin.inbox.m36')" :disabled="pending">
            <ElOption v-for="option in transitions[thread.conversation.status]" :key="option" :label="t(statuses[option])" :value="option" />
          </ElSelect>
          <label for="admin-inbox-status-reason">{{ t('admin.inbox.m37') }}</label>
          <ElInput id="admin-inbox-status-reason" v-model="reason" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :disabled="pending" />
          <ElButton native-type="submit" :loading="pending"
            :disabled="destination === undefined || !reason.trim() || reason.trim().length > 256">{{ t('admin.inbox.m38') }}</ElButton>
        </form>
      </section>
      <p v-if="notice" role="status">{{ t(notice) }}</p>
    </template>
  </section>
</template>

<style scoped>
.inbox-admin { min-width: 0; }
.inbox-admin-queue { display: grid; gap: var(--fsus-space-2); }
.inbox-admin-list { margin: 0; padding: 0; list-style: none; }
.inbox-admin-list li { padding-block: var(--fsus-space-3); border-block-end: 1px solid var(--el-border-color-lighter); }
.inbox-admin-list li > small { display: block; }
.inbox-admin-subject { min-height: 44px; padding: 0; border: 0; background: none; color: var(--el-color-primary); font: inherit; text-align: start; overflow-wrap: anywhere; cursor: pointer; }
.inbox-admin-subject:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.inbox-admin-account, .inbox-admin-body { overflow-wrap: anywhere; }
.inbox-admin-body { white-space: pre-wrap; }
.inbox-admin-reply { display: grid; gap: var(--fsus-space-2); padding-block: var(--fsus-space-3); }
.inbox-admin-reply > button { justify-self: start; }
.inbox-admin-notice-actions { display: flex; flex-wrap: wrap; gap: var(--fsus-space-2); }
.inbox-admin-notice-actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
</style>
