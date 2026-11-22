<script setup lang="ts">
import { t, siteLocale } from '../siteLocale'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { RouterLink } from 'vue-router'
import {
  ElAlert,
  ElButton,
  ElConversationContextBar,
  ElConversationList,
  ElConversationListItem,
  ElDialog,
  ElEmptySelectionState,
  ElEmptyState,
  ElInboxEmptyState,
  ElInboxLayout,
  ElInlineActions,
  ElInput,
  ElMessageBubble,
  ElMessageTimeline,
  ElOption,
  ElReplyComposerShell,
  ElSelect,
  ElSkeleton,
  ElTag,
  ElTaskPageHeader,
  ElThreadPanel,
} from '@ozwasyd/element-plus'
import { api, ApiError, ProtocolError, type InboxFilter, type InboxListItem, type InboxThread } from '../../../Contracts/client'
import { createInboxConversation, inboxComposeEnabled, replyInboxConversation } from '../../../Contracts/inbox-write'
import { watchInboxWake } from '../../../Contracts/inbox-wake'
import { useDelayedBusy } from '../delayedBusy'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential, refreshSession } from '../session'

const filters = computed<ReadonlyArray<{ value: InboxFilter; label: string }>>(() => [
  { value: 'all', label: t('account.message129') },
  { value: 'unread', label: t('account.message130') },
  { value: 'system', label: t('account.message131') },
  { value: 'open', label: t('account.message132') },
  { value: 'pending', label: t('account.message133') },
  { value: 'closed', label: t('account.message134') },
])
const statuses = computed(() => [t('account.message132'), t('account.message133'), t('account.message134')] as const)
const senders = computed(() => [t('account.message135'), t('account.message136'), t('account.message131')] as const)
const statusTagTypes = ['success', 'warning', 'info'] as const

const format = computed(() => new Intl.DateTimeFormat(siteLocale.value, { dateStyle: 'short', timeStyle: 'short' }))
const formatTimeOnly = computed(() => new Intl.DateTimeFormat(siteLocale.value, { hour: '2-digit', minute: '2-digit', hour12: false }))
const formatMonthDay = computed(() => new Intl.DateTimeFormat(siteLocale.value, { month: 'numeric', day: 'numeric' }))
const formatDateOnly = computed(() => new Intl.DateTimeFormat(siteLocale.value, { dateStyle: 'short' }))

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
const threadPanelRef = ref<ComponentPublicInstance | HTMLElement>()
const listHeading = ref<HTMLElement>()
const narrowQuery = matchMedia('(max-width: 760px)')
const mobile = ref(narrowQuery.matches)
const onViewportChange = () => { mobile.value = narrowQuery.matches }

const hasSelection = computed(() => selected.value !== null)
const selectedRow = computed(() =>
  selected.value === null ? undefined : rows.value.find(item => item.id === selected.value))
const refreshLoading = useDelayedBusy(() => listPending.value && listAction.value === 'refresh')
const moreLoading = useDelayedBusy(() => listPending.value && listAction.value === 'more')
const earlierLoading = useDelayedBusy(() => threadPending.value && threadAction.value === 'earlier')
const markLoading = useDelayedBusy(() => markPending.value)

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

function statusTagType(status: number) {
  return statusTagTypes[status] ?? 'info'
}

function messageVariant(sender: number): 'self' | 'other' | 'system' {
  if (sender === 0) return 'self'
  if (sender === 2) return 'system'
  return 'other'
}

function formatCompactTime(value: number): string {
  const date = new Date(value)
  const now = new Date()
  if (date.getFullYear() === now.getFullYear()) {
    if (date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
      return formatTimeOnly.value.format(date)
    }
    return formatMonthDay.value.format(date)
  }
  return formatDateOnly.value.format(date)
}

function rowMeta(row: InboxListItem): string {
  const time = formatCompactTime(row.lastMessageAt)
  if (row.unreadCount > 0) {
    if (row.isSystem) return `${t('account.message131')} · ${time}`
    if (row.status !== 0) return `${statuses.value[row.status]} · ${time}`
  }
  return time
}

function focusThreadHeading() {
  const target = threadPanelRef.value
  const root = target instanceof HTMLElement ? target : (target?.$el instanceof HTMLElement ? target.$el : null)
  const heading = root?.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6')
  if (!heading) return
  heading.tabIndex = -1
  heading.focus({ preventScroll: true })
}

function current(signal: AbortSignal, identity: number) {
  const session = currentSession.value
  return !signal.aborted && identity === identityEpoch.value && !!session?.siteSessionId && session.expiresAt > Date.now()
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
  const identity = identityEpoch.value
  const signal = scope.signal
  const session = currentSession.value?.siteSessionId
  const page = append ? nextPage.value : null
  if (!session || !current(signal, identity) || (append && !page)) return false
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
  const signal = scope.signal
  const identity = identityEpoch.value
  const session = currentSession.value?.siteSessionId
  if (!session || !current(signal, identity)) return false
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
      if (current(signal, identity) && selected.value === id) focusThreadHeading()
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
  const signal = scope.signal
  const identity = identityEpoch.value
  const session = currentSession.value?.siteSessionId
  if (!session || !current(signal, identity) || !writable.value || sending.value || !ticket.value.trim()) return
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
    await nextTick()
    focusThreadHeading()
    await Promise.all([loadList(), loadThread(id)])
    if (current(signal, identity) && selected.value === id) {
      await nextTick()
      focusThreadHeading()
    }
  } catch (reason) { report(reason, signal, identity, t('account.inboxError3')) }
  finally { if (current(signal, identity)) sending.value = false }
}

async function sendReply() {
  const detail = thread.value
  const signal = scope.signal
  const identity = identityEpoch.value
  const session = currentSession.value?.siteSessionId
  if (!session || !detail || selected.value !== detail.id || !current(signal, identity) ||
      !writable.value || sending.value || !reply.value.trim()) return
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
  if (!detail || markPending.value) return
  const signal = scope.signal
  const identity = identityEpoch.value
  const session = currentSession.value?.siteSessionId
  if (!session || !current(signal, identity)) return
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
      // Refetch the authoritative list to apply all events through its returned baseline.
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
  narrowQuery.addEventListener('change', onViewportChange)
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
  narrowQuery.removeEventListener('change', onViewportChange)
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
          {{ t('account.message112') }}
        </ElButton>
      </template>
    </ElAlert>

    <ElSkeleton v-if="checking && !currentSession" :rows="5" animated />

    <ElEmptyState v-else-if="!currentSession" :title="t('account.message113')">
      <template #actions>
        <RouterLink class="inbox-login-link" to="/login">{{ t('account.message80') }}</RouterLink>
      </template>
    </ElEmptyState>

    <ElInboxLayout
      v-else
      class="inbox-shell"
      :selected="hasSelection"
      :mobile-pane="hasSelection ? 'detail' : 'list'"
      :list-label="t('account.message114')"
      :detail-label="t('account.message123')"
      density="compact"
    >
      <template #list>
        <div class="inbox-list-pane" :aria-busy="listPending">
          <header class="inbox-list-toolbar">
            <h2 id="inbox-list" ref="listHeading" class="inbox-list-heading" tabindex="-1">
              {{ t('account.message114') }}
            </h2>
            <ElSelect v-model="filter" :ariaLabel="t('account.message116')" class="inbox-filter">
              <ElOption v-for="item in filters" :key="item.value" :label="item.label" :value="item.value" />
            </ElSelect>
          </header>

          <ElSkeleton v-if="listPending && !rows.length" :rows="5" animated class="inbox-pane-skeleton" />

          <ElInboxEmptyState
            v-else-if="!rows.length && !error"
            :title="t('account.message120')"
            :description="filter === 'all' ? t('account.inboxEmptyAll') : t('account.inboxEmptyFiltered')"
            density="compact"
          >
            <template v-if="filter !== 'all' || writable" #actions>
              <ElButton v-if="filter !== 'all'" native-type="button" text @click="filter = 'all'">
                {{ t('account.inboxResetFilter') }}
              </ElButton>
              <ElButton v-else-if="writable" native-type="button" type="primary" :disabled="sending" @click="openCompose">
                {{ t('account.message115') }}
              </ElButton>
            </template>
          </ElInboxEmptyState>

          <ElConversationList v-else-if="rows.length" :ariaLabel="t('account.message114')" density="compact">
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
                <ElTag v-else size="small" :type="row.isSystem ? 'info' : statusTagType(row.status)" disable-transitions>
                  {{ row.isSystem ? t('account.message131') : statuses[row.status] }}
                </ElTag>
              </template>
            </ElConversationListItem>
          </ElConversationList>

          <div v-if="nextPage" class="inbox-list-footer">
            <ElButton native-type="button" text :loading="moreLoading" @click="loadList(true, 'more')">
              {{ t('account.message121') }}
            </ElButton>
          </div>
        </div>
      </template>

      <template #detail>
        <ElThreadPanel
          v-if="thread"
          :key="`${thread.id}-${mobile ? 'm' : 'd'}-${writable ? 'w' : 'r'}`"
          ref="threadPanelRef"
          :title="thread.subject"
          title-tag="h2"
          density="compact"
          v-bind="{ 'aria-busy': threadPending || markPending || sending }"
        >
          <template v-if="mobile && hasSelection" #back>
            <ElButton native-type="button" text :disabled="sending" @click="backToList">
              {{ t('account.message122') }}
            </ElButton>
          </template>

          <template #actions>
            <ElButton
              v-if="thread.unreadCount"
              native-type="button"
              text
              type="primary"
              :loading="markLoading"
              :disabled="markPending || sending"
              @click="markRead"
            >{{ t('account.message124') }}</ElButton>
          </template>

          <template #context>
            <ElConversationContextBar class="inbox-context-bar" density="compact">
              <ElTag size="small" :type="statusTagType(thread.status)" disable-transitions>
                {{ statuses[thread.status] }}
              </ElTag>
              <ElTag v-if="thread.isSystem" size="small" type="info" disable-transitions>
                {{ t('account.message131') }}
              </ElTag>
              <ElTag v-if="thread.unreadCount" size="small" disable-transitions>
                {{ t('account.unreadCount', { count: thread.unreadCount }) }}
              </ElTag>
              <span v-if="thread.messages.length" class="inbox-context-time">
                {{ format.format(thread.messages[thread.messages.length - 1].createdAt) }}
              </span>
            </ElConversationContextBar>
          </template>

          <template #messages>
            <div v-if="thread.previous" class="inbox-earlier">
              <ElButton
                native-type="button"
                text
                :loading="earlierLoading"
                @click="loadThread(thread.id, thread.previous)"
              >{{ t('account.message126') }}</ElButton>
            </div>
            <ElMessageTimeline density="compact">
              <ElMessageBubble
                v-for="message in thread.messages"
                :key="String(message.id)"
                :variant="messageVariant(message.sender)"
                :author="senders[message.sender]"
                :meta="format.format(message.createdAt)"
                density="compact"
              >{{ message.body }}</ElMessageBubble>
            </ElMessageTimeline>
          </template>

          <template v-if="writable || thread.status === 2" #composer>
            <form v-if="writable && thread.status !== 2" @submit.prevent="sendReply">
              <ElReplyComposerShell density="compact">
                <template #title>
                  <label class="inbox-composer-label" for="reply-body">{{ t('account.message127') }}</label>
                </template>
                <template #input>
                  <ElInput
                    id="reply-body"
                    v-model="reply"
                    type="textarea"
                    :placeholder="t('account.inboxReplyPlaceholder')"
                    :autosize="{ minRows: 2, maxRows: 6 }"
                    :disabled="sending"
                  />
                </template>
                <template #actions>
                  <ElButton type="primary" native-type="submit" :disabled="!reply.trim()" :loading="sending">
                    {{ t('account.message128') }}
                  </ElButton>
                </template>
              </ElReplyComposerShell>
            </form>
            <p v-else-if="thread.status === 2" class="inbox-closed-note">
              {{ t('account.inboxClosedHint') }}
            </p>
          </template>
        </ElThreadPanel>

        <div v-else-if="hasSelection" class="inbox-detail-loading" :aria-busy="threadPending">
          <div v-if="selectedRow" class="inbox-detail-loading-header">
            <ElButton v-if="mobile" native-type="button" text :disabled="sending" @click="backToList">
              {{ t('account.message122') }}
            </ElButton>
            <span class="inbox-detail-loading-title">{{ selectedRow.subject }}</span>
          </div>
          <ElSkeleton :rows="6" animated class="inbox-pane-skeleton" />
        </div>

        <ElEmptySelectionState
          v-else
          :title="t('account.message125')"
          :description="t('account.inboxSelectHint')"
        />
      </template>
    </ElInboxLayout>

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
            {{ t('account.inboxCancel') }}
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

<style scoped>
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

.inbox-list-pane {
  display: grid;
  align-content: start;
  min-inline-size: 0;
}

.inbox-list-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-2);
  align-items: safe center;
  justify-content: space-between;
  padding: var(--fsus-space-3);
  border-block-end: 1px solid var(--el-border-color-lighter);
  background: var(--fsus-color-surface-raised, var(--el-fill-color-blank));
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

.inbox-pane-skeleton {
  padding: var(--fsus-space-4);
}

.inbox-list-footer,
.inbox-earlier {
  display: flex;
  justify-content: center;
  padding: var(--fsus-space-2) var(--fsus-space-3);
}

.inbox-context-bar {
  align-items: safe center;
}

.inbox-context-time {
  margin-inline-start: auto;
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-extra-small);
  font-variant-numeric: tabular-nums;
}

.inbox-composer-label {
  display: inline-block;
  color: inherit;
  cursor: pointer;
}

.inbox-closed-note {
  margin: 0;
  padding: var(--fsus-space-3) var(--fsus-space-4);
  color: var(--el-text-color-secondary);
  font-size: var(--el-font-size-small);
  line-height: 1.5;
}

.inbox-dialog-form {
  display: grid;
  gap: var(--fsus-space-4);
}

.inbox-dialog-field {
  display: grid;
  gap: 6px;
  min-inline-size: 0;
}

.inbox-dialog-field label {
  font-size: var(--el-font-size-small);
  font-weight: 500;
  color: var(--el-text-color-regular);
  line-height: 1.4;
}

.inbox-detail-loading {
  display: grid;
  align-content: start;
  min-inline-size: 0;
}

.inbox-detail-loading-header {
  display: flex;
  align-items: safe center;
  gap: var(--fsus-space-2);
  padding: var(--fsus-space-3);
  border-block-end: 1px solid var(--el-border-color-lighter);
}

.inbox-detail-loading-title {
  color: var(--el-text-color-primary);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

@media (min-width: 761px) {
  .inbox-shell {
    block-size: clamp(30rem, calc(100dvh - 14.5rem), 52rem);
    grid-template-rows: minmax(0, 1fr);
  }
}

@media (min-width: 1024px) {
  .inbox-shell {
    grid-template-columns: minmax(21.5rem, 23.5rem) minmax(0, 1fr);
  }
}
</style>
