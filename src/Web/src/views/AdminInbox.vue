<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/client'
import { adminSendNotice, isNoticeRecipient, newNoticeEventId } from '../../../Contracts/admin-inbox-notice'
import { adminChangeStatus, adminInbox, adminInboxThread, adminReply, type AdminInboxFilter, type AdminInboxRow,
  type AdminInboxStatus, type AdminInboxThread } from '../../../Contracts/admin-inbox'

const props = defineProps<{ sessionSignal: AbortSignal }>()
const emit = defineEmits<{ sessionLost: [error: unknown] }>()
const rows = shallowRef<AdminInboxRow[]>([])
const thread = shallowRef<AdminInboxThread>()
const next = ref<string | null>(null)
const filter = ref<AdminInboxFilter>('')
const expanded = ref(false)
const pending = ref(false)
const failed = ref('')
const title = ref<HTMLElement>()
const reply = ref('')
const notice = ref('')
const destination = ref<AdminInboxStatus>()
const reason = ref('')
const needsRefresh = ref(false)
const noticesEnabled = ref(false)
const composeNotice = ref(false)
const recipient = ref('')
const noticeSubject = ref('')
const noticeBody = ref('')
const statuses = ['Open', 'Pending', 'Closed'] as const
const statusFilters = ['open', 'pending', 'closed'] as const
const transitions: readonly (readonly AdminInboxStatus[])[] = [[1, 2], [0, 2], [0]]
const senders = ['Account', 'Administrator', 'System'] as const
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
}

function closeThread() {
  thread.value = undefined
  clearReply()
  clearStatus()
  void nextTick(() => { if (opener?.isConnected) opener.focus() })
}

async function read(load: (signal: AbortSignal) => Promise<void>, message = 'Could not read the administrator inbox. Refresh and try again.') {
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
    const page = await adminInbox(filter.value, cursor, signal)
    if (signal.aborted) return
    rows.value = cursor ? [...rows.value, ...page.rows] : page.rows
    next.value = page.next
    noticesEnabled.value = page.noticesEnabled
  })
}

function openThread(id: bigint, before: string | null = null, event?: MouseEvent) {
  if (event?.currentTarget instanceof HTMLElement) opener = event.currentTarget
  void read(async signal => {
    const page = await adminInboxThread(id, before, signal)
    if (signal.aborted) return
    thread.value = before && thread.value?.conversation.id === id
      ? { ...page, messages: [...page.messages, ...thread.value.messages] } : page
    if (!before) {
      clearStatus()
      void nextTick(() => title.value?.focus())
    }
  })
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
    notice.value = 'System notice sent to the account.'
    const page = await adminInbox(filter.value, null, signal)
    if (!signal.aborted) {
      rows.value = page.rows
      next.value = page.next
      noticesEnabled.value = page.noticesEnabled
    }
  }, 'Could not complete the system notice request. Retry the same form to keep its source event.')
}

async function refreshThread(id: bigint, signal: AbortSignal) {
  const latest = await adminInboxThread(id, null, signal)
  if (signal.aborted) return
  const current = thread.value
  if (current?.conversation.id !== id) return
  const first = latest.messages[0].id
  const older = current.messages.filter(message => message.id < first)
  thread.value = older.length ? { ...latest, previous: current.previous, messages: [...older, ...latest.messages] } : latest
  needsRefresh.value = false
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
    notice.value = 'Reply sent to the account.'
    if (current.version) {
      needsRefresh.value = true
      await refreshThread(conversation, signal)
    }
  }, 'Could not send the reply. Retry to keep the same command.')
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
    rows.value = filter.value && filter.value !== statusFilters[saved.current]
      ? rows.value.filter(item => item.id !== conversation)
      : rows.value.map(item => item.id === conversation ? updated : item)
    clearStatus()
    notice.value = saved.changed ? 'Conversation status saved.' : 'The conversation already has this status.'
    needsRefresh.value = true
    await refreshThread(conversation, signal)
  }, 'Could not complete the status update. Reload the conversation before trying again.')
}

function reloadThread() {
  const current = thread.value
  if (current) void read(signal => refreshThread(current.conversation.id, signal))
}

function toggle() {
  expanded.value = !expanded.value
  reset()
  if (expanded.value) loadQueue()
}

watch(filter, () => { if (expanded.value) { reset(); loadQueue() } })
watch(() => props.sessionSignal, () => { expanded.value = false; reset() }, { flush: 'sync' })
onBeforeUnmount(() => operation.abort())
</script>

<template>
  <section class="auth-form inbox-admin" aria-labelledby="admin-inbox-title">
    <h2 id="admin-inbox-title">Support inbox</h2>
    <ElButton native-type="button" @click="toggle">{{ expanded ? 'Close support inbox' : 'Open support inbox' }}</ElButton>
    <template v-if="expanded">
      <ElAlert v-if="failed" :title="failed" type="error" :closable="false" />
      <div v-show="!thread" class="inbox-admin-queue" :aria-busy="pending">
        <ElSelect v-model="filter" ariaLabel="Filter support inbox" :disabled="pending">
          <ElOption label="All conversations" value="" />
          <ElOption label="Open" value="open" />
          <ElOption label="Pending" value="pending" />
          <ElOption label="Closed" value="closed" />
        </ElSelect>
        <ElButton native-type="button" text :loading="pending" @click="loadQueue()">Refresh conversations</ElButton>
        <ElButton v-if="noticesEnabled && !composeNotice" native-type="button" :disabled="pending"
          @click="composeNotice = true">Compose system notice</ElButton>
        <form v-if="noticesEnabled && composeNotice" class="inbox-admin-reply" @submit.prevent="sendNotice">
          <label for="admin-notice-account">Recipient account UUID</label>
          <ElInput id="admin-notice-account" v-model="recipient" :disabled="pending" />
          <label for="admin-notice-subject">Notice subject</label>
          <ElInput id="admin-notice-subject" v-model="noticeSubject" :disabled="pending" />
          <label for="admin-notice-body">Notice message</label>
          <ElInput id="admin-notice-body" v-model="noticeBody" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :disabled="pending" />
          <div class="inbox-admin-notice-actions">
            <ElButton native-type="submit" type="primary" :loading="pending"
              :disabled="!isNoticeRecipient(recipient.trim()) || !noticeBody.trim()">Send system notice</ElButton>
            <ElButton native-type="button" :disabled="pending" @click="clearNotice">Cancel notice</ElButton>
          </div>
        </form>
        <p v-if="!pending && !failed && rows.length === 0">No conversations.</p>
        <ul v-if="rows.length" class="inbox-admin-list">
          <li v-for="item in rows" :key="String(item.id)">
            <button type="button" class="inbox-admin-subject" :disabled="pending" @click="openThread(item.id, null, $event)">{{ item.subject }}</button>
            <small>{{ statuses[item.status] }} · {{ item.system ? 'System notice' : 'Account ticket' }}</small>
          </li>
        </ul>
        <ElButton v-if="next" native-type="button" text :disabled="pending" @click="loadQueue(next)">Load more conversations</ElButton>
      </div>
      <section v-if="thread" aria-labelledby="admin-inbox-thread" :aria-busy="pending">
        <ElButton native-type="button" text :disabled="pending" @click="closeThread">Back to conversations</ElButton>
        <ElButton v-if="thread.version || needsRefresh" native-type="button" text :disabled="pending"
          @click="reloadThread">Reload conversation</ElButton>
        <h3 id="admin-inbox-thread" ref="title" tabindex="-1">{{ thread.conversation.subject }}</h3>
        <p>{{ statuses[thread.conversation.status] }} · {{ thread.conversation.system ? 'System notice' : 'Account ticket' }}</p>
        <p class="inbox-admin-account">Account {{ thread.conversation.account }}</p>
        <ElButton v-if="thread.previous" native-type="button" text :disabled="pending"
          @click="openThread(thread.conversation.id, thread.previous)">Load earlier messages</ElButton>
        <ol class="inbox-admin-list">
          <li v-for="message in thread.messages" :key="String(message.id)">
            <small>{{ senders[message.sender] }}<template v-if="message.internal"> · Internal note</template> · {{ new Date(message.at).toLocaleString() }}</small>
            <p class="inbox-admin-body">{{ message.body }}</p>
          </li>
        </ol>
        <form v-if="thread.repliesEnabled && thread.conversation.status !== 2" class="inbox-admin-reply" @submit.prevent="sendReply">
          <label for="admin-inbox-reply">Reply to the account</label>
          <ElInput id="admin-inbox-reply" v-model="reply" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :disabled="pending" />
          <ElButton native-type="submit" type="primary" :loading="pending" :disabled="!reply.trim()">Send reply</ElButton>
        </form>
        <form v-if="thread.version" class="inbox-admin-reply" @submit.prevent="saveStatus">
          <ElSelect v-model="destination" ariaLabel="New conversation status" placeholder="Choose a status" :disabled="pending">
            <ElOption v-for="option in transitions[thread.conversation.status]" :key="option" :label="statuses[option]" :value="option" />
          </ElSelect>
          <label for="admin-inbox-status-reason">Reason for changing status</label>
          <ElInput id="admin-inbox-status-reason" v-model="reason" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" :disabled="pending" />
          <ElButton native-type="submit" :loading="pending"
            :disabled="destination === undefined || !reason.trim() || reason.trim().length > 256">Save status</ElButton>
        </form>
      </section>
      <p v-if="notice" role="status">{{ notice }}</p>
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
