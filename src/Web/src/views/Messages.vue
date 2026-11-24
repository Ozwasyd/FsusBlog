<script setup lang="ts">
import { t, siteLocale } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ElAlert,
  ElButton,
  ElConversationListItem,
  ElDialog,
  ElEmptyState,
  ElInlineActions,
  ElInput,
  ElOption,
  ElSelect,
  ElSkeleton,
  ElTag,
  ElTaskPageHeader,
} from '@ozwasyd/element-plus'
import { api, ApiError, ProtocolError, type InboxFilter, type InboxListItem, type InboxThread } from '../../../Contracts/client'
import { createInboxConversation, inboxComposeEnabled, replyInboxConversation } from '../../../Contracts/inbox-write'
import { watchInboxWake } from '../../../Contracts/inbox-wake'
import InboxSplitWorkspace from '../components/InboxSplitWorkspace.vue'
import { useDelayedBusy, useMediaQuery } from '../delayedBusy'
import {
  createInboxTimeFormatter,
  inboxBubbleVariant,
  inboxStatusTagType,
  type InboxRenderedMessage,
} from '../inboxPresentation'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential, refreshSession } from '../session'

const filters = computed<ReadonlyArray<{ value: InboxFilter; label: string }>>(() => [
  { value: 'all', label: t('account.message129') },
  { value: 'unread', label: t('account.message130') },
  { value: 'system', label: t('admin.inbox.m32') },
  { value: 'open', label: t('account.message132') },
  { value: 'pending', label: t('account.message133') },
  { value: 'closed', label: t('admin.inbox.m8') },
])
const statuses = computed(() => [t('account.message132'), t('account.message133'), t('admin.inbox.m8')] as const)
const senders = computed(() => [t('account.message135'), t('admin.inbox.m31'), t('admin.inbox.m32')] as const)
const timeFormat = computed(() => createInboxTimeFormatter(siteLocale.value))

const filter = ref<InboxFilter>('all')
const rows = shallowRef<readonly InboxListItem[]>([])
const nextPage = ref<string | null>(null)
const selected = ref<bigint | null>(null)
const thread = shallowRef<InboxThread | null>(null)
const listPending = ref(false)
const listAction = ref<'refresh' | 'more' | null>(null)
const threadPending = ref(false)
const threadAction = ref<'earlier' | null>(null)
const markPending = ref(false)
const checking = ref(true)
const writable = ref(false)
const sending = ref(false)
const composing = ref(false)
const subject = ref('')
const ticket = ref('')
const reply = ref('')
const notice = ref('')
const error = ref('')
const workspace = ref<InstanceType<typeof InboxSplitWorkspace>>()
const listHeading = ref<HTMLElement>()
const mobile = useMediaQuery('(max-width: 760px)')

const hasSelection = computed(() => selected.value !== null)
const selectedRow = computed(() =>
  selected.value === null ? undefined : rows.value.find(item => item.id === selected.value))
const refreshLoading = useDelayedBusy(() => listPending.value && listAction.value === 'refresh')
const moreLoading = useDelayedBusy(() => listPending.value && listAction.value === 'more')
const earlierLoading = useDelayedBusy(() => threadPending.value && threadAction.value === 'earlier')
const markLoading = useDelayedBusy(() => markPending.value)

const renderedMessages = computed<readonly InboxRenderedMessage[]>(() => {
  const currentThread = thread.value
  if (!currentThread) return []
  const formatter = timeFormat.value
  const senderLabels = senders.value
  return currentThread.messages.map(message => ({
    id: String(message.id),
    variant: inboxBubbleVariant(message.sender, 'reader'),
    author: senderLabels[message.sender],
    meta: formatter.full(message.createdAt),
    body: message.body,
  }))
})

const threadKey = computed(() =>
  thread.value ? `${thread.value.id}-${mobile.value ? 'm' : 'd'}-${writable.value ? 'w' : 'r'}-${thread.value.status}` : '')

let scope = new AbortController()
let listRequest = 0
let threadRequest = 0
let cursor: string | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let polling = false
let wakePending = false
let streamOpen = false
let opener: HTMLButtonElement | undefined
let createAttempt: { subject: string; body: string; key: string } | undefined
const replies = new Map<bigint, { body: string; snapshot?: bigint; key?: string }>()

function rowMeta(row: InboxListItem): string {
  const time = timeFormat.value.compact(row.lastMessageAt)
  if (row.unreadCount > 0) {
    if (row.isSystem) return `${t('admin.inbox.m32')} · ${time}`
    if (row.status !== 0) return `${statuses.value[row.status]} · ${time}`
  }
  return time
}

function current(signal: AbortSignal, identity: number) {
  const session = currentSession.value
  return !signal.aborted && identity === identityEpoch.value && !!session?.siteSessionId && session.expiresAt > Date.now()
}

function activeContext() {
  const signal = scope.signal, identity = identityEpoch.value, session = currentSession.value?.siteSessionId
  return session && current(signal, identity) ? { signal, identity, session } : undefined
}

function report(failure: unknown, signal: AbortSignal, identity: number, fallback: string) {
  if (!current(signal, identity)) return
  if (failure instanceof ApiError && failure.status === 401 && !failure.details.startsWith('pow_')) recheck(signal)
  else {
    if (failure instanceof ApiError && failure.status === 409) void refreshSession(signal).catch(() => {})
    error.value = fallback
  }
}

function recheck(signal: AbortSignal) {
  const handle = currentSession.value?.siteSessionId
  if (handle) void recheckCredential(handle, signal)
}

async function loadList(append = false, source: 'refresh' | 'more' | null = append ? 'more' : null): Promise<boolean> {
  const ctx = activeContext()
  const page = append ? nextPage.value : null
  if (!ctx || (append && !page)) return false
  const { signal, identity, session } = ctx
  const request = ++listRequest
  listAction.value = source
  listPending.value = true
  try {
    const result = await api.inboxList(filter.value, page ?? undefined, signal, session)
    if (!current(signal, identity) || request !== listRequest) return false
    if (!append && !result.replayCursor) throw new ProtocolError('Missing inbox replay baseline')
    const existing = new Set(append ? rows.value.map(row => row.id) : [])
    rows.value = [...(append ? rows.value : []), ...result.items.filter(row => !existing.has(row.id))]
    nextPage.value = result.next
    if (!append) cursor = result.replayCursor ?? undefined
    error.value = ''
    return true
  } catch (failure) {
    if (request === listRequest) report(failure, signal, identity, t('account.inboxError1'))
    return false
  } finally {
    if (request === listRequest && current(signal, identity)) {
      listPending.value = false
      listAction.value = null
    }
  }
}

async function loadThread(id: bigint, older?: bigint, focusOnReady = false): Promise<boolean> {
  const ctx = activeContext()
  if (!ctx) return false
  const { signal, identity, session } = ctx
  const request = ++threadRequest
  threadAction.value = older !== undefined ? 'earlier' : null
  threadPending.value = true
  try {
    const result = await api.inboxThread(id, older, signal, session)
    if (!current(signal, identity) || request !== threadRequest || selected.value !== id) return false
    if (result.id !== id) throw new ProtocolError('Inbox response changed conversation')
    const previous = thread.value
    thread.value = older && previous
      ? { ...result, readThrough: previous.readThrough, messages: [...result.messages, ...previous.messages] }
      : result
    error.value = ''
    if (focusOnReady || (previous === null && older === undefined)) {
      await nextTick()
      if (current(signal, identity) && selected.value === id) workspace.value?.focusThreadHeading()
    }
    return true
  } catch (failure) {
    if (request === threadRequest) report(failure, signal, identity, t('account.inboxError2'))
    return false
  } finally {
    if (request === threadRequest && current(signal, identity)) {
      threadPending.value = false
      threadAction.value = null
    }
  }
}

function selectConversation(id: bigint, event: MouseEvent) {
  const trigger = event.currentTarget instanceof HTMLButtonElement
    ? event.currentTarget
    : (event.target instanceof Element ? event.target.closest('button') ?? undefined : undefined)
  opener = trigger
  const alreadyLoaded = selected.value === id && thread.value?.id === id
  selected.value = id
  reply.value = replies.get(id)?.body ?? ''
  if (!alreadyLoaded) thread.value = null
  void loadThread(id, undefined, true)
}

function backToList() {
  selected.value = null
  thread.value = null
  threadPending.value = false
  threadAction.value = null
  reply.value = ''
  threadRequest++
  void nextTick(() => (opener?.isConnected ? opener : listHeading.value)?.focus())
}

function openCompose() {
  error.value = ''
  composing.value = true
}

function closeCompose() {
  if (sending.value) return
  composing.value = false
}

watch(reply, body => {
  if (selected.value === null) return
  if (!body) {
    replies.delete(selected.value)
    return
  }
  const previous = replies.get(selected.value)
  if (!previous || previous.body !== body) replies.set(selected.value, { body })
}, { flush: 'sync' })

async function sendTicket() {
  const ctx = activeContext()
  if (!ctx || !writable.value || sending.value || !ticket.value.trim()) return
  const { signal, identity, session } = ctx
  const input = { subject: subject.value, body: ticket.value }
  if (!createAttempt || createAttempt.body !== input.body || createAttempt.subject !== input.subject)
    createAttempt = { ...input, key: crypto.randomUUID() }
  sending.value = true
  error.value = ''
  try {
    const id = await createInboxConversation(input.subject, input.body, createAttempt.key, signal, session)
    if (!current(signal, identity)) return
    createAttempt = undefined
    subject.value = ''
    ticket.value = ''
    composing.value = false
    notice.value = t('account.message137')
    opener = undefined
    selected.value = id
    reply.value = replies.get(id)?.body ?? ''
    thread.value = null
    await Promise.all([loadList(), loadThread(id, undefined, true)])
  } catch (reason) { report(reason, signal, identity, t('account.inboxError3')) }
  finally { if (current(signal, identity)) sending.value = false }
}

async function sendReply() {
  const detail = thread.value
  const ctx = activeContext()
  if (!ctx || !detail || selected.value !== detail.id || !writable.value || sending.value || !reply.value.trim()) return
  const { signal, identity, session } = ctx
  const saved = replies.get(detail.id)
  const body = reply.value
  const snapshot = saved?.body === body && saved.snapshot ? saved.snapshot : detail.readThrough
  const key = saved?.body === body && saved.key ? saved.key : crypto.randomUUID()
  replies.set(detail.id, { body, snapshot, key })
  sending.value = true
  error.value = ''
  try {
    await replyInboxConversation(detail.id, snapshot, body, key, signal, session)
    if (!current(signal, identity)) return
    replies.delete(detail.id)
    if (selected.value === detail.id) {
      reply.value = ''
      await loadThread(detail.id)
    }
    notice.value = t('account.message138')
    await loadList()
  } catch (reason) {
    if (current(signal, identity) && reason instanceof ApiError && reason.status === 409) {
      replies.set(detail.id, { body })
      await loadThread(detail.id)
    }
    report(reason, signal, identity, t('account.inboxError4'))
  }
  finally { if (current(signal, identity)) sending.value = false }
}

async function markRead() {
  const detail = thread.value
  const ctx = activeContext()
  if (!detail || markPending.value || !ctx) return
  const { signal, identity, session } = ctx
  markPending.value = true
  try {
    await api.inboxRead(detail.id, detail.readThrough, signal, session)
    if (!current(signal, identity)) return
    await Promise.all([loadList(), selected.value === detail.id ? loadThread(detail.id) : undefined])
  } catch (failure) {
    report(failure, signal, identity, t('account.inboxError5'))
  } finally {
    if (current(signal, identity)) markPending.value = false
  }
}

async function reloadInbox(fallback?: string, source: 'refresh' | null = null) {
  const signal = scope.signal
  const identity = identityEpoch.value
  const id = selected.value
  const resume = await loadList(false, source)
  const baseline = cursor
  if (resume && id !== null && selected.value === id && !await loadThread(id) && current(signal, identity) && cursor === baseline)
    cursor = fallback
}

async function poll(signal: AbortSignal, identity: number) {
  const session = currentSession.value?.siteSessionId
  if (!session || !current(signal, identity) || polling) return
  clearTimeout(pollTimer)
  polling = true
  wakePending = false
  try {
    if (document.visibilityState !== 'visible' || listPending.value || markPending.value || sending.value) return
    if (!cursor) {
      await reloadInbox()
      return
    }
    const previous = cursor
    const page = await api.inboxReplay(previous, signal, session)
    if (!current(signal, identity) || cursor !== previous) return
    if (page.requiresResync || page.events.length > 0) {
      await reloadInbox(previous)
    } else {
      cursor = page.cursor
    }
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 409 && current(signal, identity)) {
      await reloadInbox()
    } else report(failure, signal, identity, t('account.inboxError6'))
  } finally {
    if (current(signal, identity)) {
      polling = false
      pollTimer = setTimeout(() => { void poll(signal, identity) }, wakePending ? 250 : streamOpen ? 15_000 : 4000)
    }
  }
}

function wake(signal: AbortSignal, identity: number) {
  if (!current(signal, identity)) return
  if (polling) wakePending = true
  else if (!listPending.value && !markPending.value && !sending.value) void poll(signal, identity)
}

function resume() {
  if (document.visibilityState === 'visible') wake(scope.signal, identityEpoch.value)
}

let ownerEpoch: number | undefined
watch(credentialEpoch, () => {
  const identity = identityEpoch.value
  const changedIdentity = ownerEpoch !== identity
  ownerEpoch = identity
  scope.abort()
  scope = new AbortController()
  clearTimeout(pollTimer)
  polling = false
  wakePending = false
  streamOpen = false
  if (changedIdentity) {
    selected.value = null
    composing.value = false
    subject.value = ''
    ticket.value = ''
    reply.value = ''
    notice.value = ''
    createAttempt = undefined
    replies.clear()
    opener = undefined
  }
  thread.value = null
  rows.value = []
  nextPage.value = null
  writable.value = false
  sending.value = false
  cursor = undefined
  error.value = ''
  listPending.value = false
  listAction.value = null
  threadPending.value = false
  threadAction.value = null
  markPending.value = false
  if (current(scope.signal, identity)) {
    const signal = scope.signal
    void inboxComposeEnabled(signal).then(enabled => {
      if (current(signal, identity)) writable.value = enabled
    }).catch(() => {})
    const active = selected.value
    void Promise.all([loadList(), active === null ? undefined : loadThread(active)]).then(() => {
      if (!current(signal, identity)) return
      watchInboxWake(signal, () => wake(signal, identity), connected => {
        if (!current(signal, identity)) return
        streamOpen = connected
        if (connected) wake(signal, identity)
        else if (!polling) {
          clearTimeout(pollTimer)
          pollTimer = setTimeout(() => { void poll(signal, identity) }, 4000)
        }
      }, () => { if (current(signal, identity)) recheck(signal) })
      void poll(signal, identity)
    })
  }
}, { immediate: true, flush: 'sync' })

watch(filter, () => {
  rows.value = []
  nextPage.value = null
  if (currentSession.value) void loadList()
})

onMounted(async () => {
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('online', resume)
  const signal = scope.signal
  try { if (!currentSession.value) await refreshSession(signal) }
  catch { if (!signal.aborted) error.value = t('account.message139') }
  finally { checking.value = false }
})

onBeforeUnmount(() => {
  scope.abort()
  clearTimeout(pollTimer)
  document.removeEventListener('visibilitychange', resume)
  window.removeEventListener('online', resume)
})
</script>

<template>
  <main class="inbox-page">
    <ElTaskPageHeader
      :key="currentSession ? 'signed-in' : 'signed-out'"
      :title="t('account.message110')"
      :description="currentSession ? t('account.inboxSummary') : undefined"
      density="compact"
    >
      <template v-if="currentSession" #actions>
        <ElInlineActions class="inbox-header-actions" density="compact">
          <ElButton
            native-type="button"
            text
            :loading="refreshLoading"
            :disabled="sending"
            @click="reloadInbox(cursor, 'refresh')"
          >{{ t('account.inboxRefresh') }}</ElButton>
          <ElButton
            v-if="writable"
            native-type="button"
            type="primary"
            :disabled="sending"
            @click="openCompose"
          >{{ t('account.message115') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElTaskPageHeader>

    <ElAlert
      v-if="notice"
      :title="notice"
      type="success"
      show-icon
      @close="notice = ''"
    />

    <ElAlert
      v-if="error && !composing"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    >
      <template v-if="currentSession" #default>
        <ElButton native-type="button" text @click="reloadInbox(cursor, 'refresh')">
          {{ t('reading.retry') }}
        </ElButton>
      </template>
    </ElAlert>

    <ElSkeleton v-if="checking && !currentSession" :rows="5" animated />

    <ElEmptyState v-else-if="!currentSession" :title="t('account.message113')">
      <template #actions>
        <RouterLink class="inbox-login-link" to="/login">{{ t('page.login') }}</RouterLink>
      </template>
    </ElEmptyState>

    <InboxSplitWorkspace
      v-else
      ref="workspace"
      :has-selection="hasSelection"
      :has-thread="Boolean(thread)"
      :list-label="t('account.message114')"
      :detail-label="t('account.message123')"
      :list-busy="listPending"
      :list-empty="rows.length === 0"
      :list-error="Boolean(error)"
      :empty-list-title="t('account.message120')"
      :empty-list-description="filter === 'all' ? t('account.inboxEmptyAll') : t('account.inboxEmptyFiltered')"
      :has-empty-list-actions="filter !== 'all' || writable"
      :has-more="Boolean(nextPage)"
      :more-loading="moreLoading"
      :more-label="t('admin.inbox.m24')"
      :thread-key="threadKey"
      :thread-title="thread?.subject ?? ''"
      thread-title-tag="h2"
      :thread-busy="threadPending || markPending || sending"
      :show-back="mobile && hasSelection"
      :back-disabled="sending"
      :back-label="t('account.message122')"
      :has-earlier="Boolean(thread?.previous)"
      :earlier-loading="earlierLoading"
      :earlier-label="t('account.message126')"
      :messages="renderedMessages"
      :reply-enabled="Boolean(thread && writable && thread.status !== 2)"
      reply-input-id="reply-body"
      :reply-label="t('account.message127')"
      :reply-placeholder="t('account.inboxReplyPlaceholder')"
      v-model:reply-model="reply"
      :reply-disabled="sending"
      :reply-pending="sending"
      :reply-submit-label="t('admin.inbox.m34')"
      :closed-note="thread?.status === 2 ? t('account.inboxClosedHint') : ''"
      :empty-selection-title="t('account.message125')"
      :empty-selection-description="t('account.inboxSelectHint')"
      :detail-loading-title="selectedRow?.subject ?? ''"
      :show-detail-loading-back="mobile"
      @load-more="loadList(true, 'more')"
      @back="backToList"
      @load-earlier="thread && thread.previous && loadThread(thread.id, thread.previous)"
      @submit-reply="sendReply"
    >
      <template #list-toolbar>
        <header class="inbox-list-toolbar-row">
          <h2 id="inbox-list" ref="listHeading" class="inbox-list-heading" tabindex="-1">
            {{ t('account.message114') }}
          </h2>
          <ElSelect v-model="filter" :ariaLabel="t('account.message116')" class="inbox-filter">
            <ElOption v-for="item in filters" :key="item.value" :label="item.label" :value="item.value" />
          </ElSelect>
        </header>
      </template>

      <template #empty-list-actions>
        <ElButton v-if="filter !== 'all'" native-type="button" text @click="filter = 'all'">
          {{ t('account.inboxResetFilter') }}
        </ElButton>
        <ElButton v-else-if="writable" native-type="button" type="primary" :disabled="sending" @click="openCompose">
          {{ t('account.message115') }}
        </ElButton>
      </template>

      <template #list-items>
        <ElConversationListItem
          v-for="row in rows"
          :key="String(row.id)"
          :title="row.subject"
          :preview="row.preview || undefined"
          :meta="rowMeta(row)"
          :selected="row.id === selected"
          :disabled="sending"
          density="compact"
          @select="selectConversation(row.id, $event)"
        >
          <template #badges>
            <ElTag v-if="row.unreadCount" size="small" disable-transitions>
              {{ t('account.unreadCount', { count: row.unreadCount }) }}
            </ElTag>
            <ElTag v-else size="small" :type="row.isSystem ? 'info' : inboxStatusTagType(row.status)" disable-transitions>
              {{ row.isSystem ? t('admin.inbox.m32') : statuses[row.status] }}
            </ElTag>
          </template>
        </ElConversationListItem>
      </template>

      <template #thread-actions>
        <ElButton
          v-if="thread?.unreadCount"
          native-type="button"
          text
          type="primary"
          :loading="markLoading"
          :disabled="markPending || sending"
          @click="markRead"
        >{{ t('account.message124') }}</ElButton>
      </template>

      <template v-if="thread" #thread-context>
        <ElTag size="small" :type="inboxStatusTagType(thread.status)" disable-transitions>
          {{ statuses[thread.status] }}
        </ElTag>
        <ElTag v-if="thread.isSystem" size="small" type="info" disable-transitions>
          {{ t('admin.inbox.m32') }}
        </ElTag>
        <ElTag v-if="thread.unreadCount" size="small" disable-transitions>
          {{ t('account.unreadCount', { count: thread.unreadCount }) }}
        </ElTag>
        <span v-if="thread.messages.length" class="inbox-context-time">
          {{ timeFormat.full(thread.messages[thread.messages.length - 1].createdAt) }}
        </span>
      </template>
    </InboxSplitWorkspace>

    <ElDialog
      v-if="currentSession && writable"
      :model-value="composing"
      :title="t('account.message115')"
      append-to-body
      width="min(32rem, calc(100vw - 2rem))"
      :close-on-press-escape="!sending"
      :close-on-click-modal="!sending"
      :show-close="!sending"
      @update:model-value="open => { if (!open) closeCompose() }"
    >
      <form id="inbox-ticket-form" class="inbox-dialog-form" @submit.prevent="sendTicket">
        <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <div class="inbox-dialog-field">
          <label for="ticket-subject">{{ t('account.message117') }}</label>
          <ElInput
            id="ticket-subject"
            v-model="subject"
            :placeholder="t('account.inboxSubjectPlaceholder')"
            :disabled="sending"
          />
        </div>
        <div class="inbox-dialog-field">
          <label for="ticket-body">{{ t('account.message118') }}</label>
          <ElInput
            id="ticket-body"
            v-model="ticket"
            type="textarea"
            :placeholder="t('account.inboxBodyPlaceholder')"
            :autosize="{ minRows: 4, maxRows: 8 }"
            :disabled="sending"
          />
        </div>
      </form>
      <template #footer>
        <ElInlineActions density="compact">
          <ElButton native-type="button" :disabled="sending" @click="closeCompose">
            {{ t('nav.cancel') }}
          </ElButton>
          <ElButton
            type="primary"
            native-type="submit"
            v-bind="{ form: 'inbox-ticket-form' }"
            :disabled="!ticket.trim()"
            :loading="sending"
          >{{ t('account.message119') }}</ElButton>
        </ElInlineActions>
      </template>
    </ElDialog>
  </main>
</template>

<style scoped lang="scss">
@use '../shared-fields' as fields;

.inbox-page {
  display: grid;
  gap: var(--fsus-space-4);
  min-inline-size: 0;
}

.inbox-header-actions {
  align-items: safe center;
}

.inbox-login-link {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  color: var(--fsus-scholarly-blue);
  font-weight: 500;
}

.inbox-list-toolbar-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-2);
  align-items: safe center;
  justify-content: space-between;
}

.inbox-list-heading {
  margin: 0;
  font-size: var(--el-font-size-base);
  font-weight: 700;
  line-height: 1.4;
  color: var(--el-text-color-primary);
}

.inbox-filter {
  inline-size: min(9.5rem, 100%);
}

.inbox-context-time {
  margin-inline-start: auto;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-extra-small);
  font-variant-numeric: tabular-nums;
}

.inbox-dialog-form {
  display: grid;
  gap: var(--fsus-space-4);
}

.inbox-dialog-field {

  @include fields.account-field;
}

.inbox-dialog-field label {

  @include fields.account-label;
}
</style>
