<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElEmptyState, ElInput, ElOption, ElSelect, ElSkeleton, ElTaskPageHeader } from '@ozwasyd/element-plus'
import { api, ApiError, ProtocolError, type InboxFilter, type InboxListItem, type InboxThread } from '../../../Contracts/client'
import { createInboxConversation, inboxComposeEnabled, replyInboxConversation } from '../../../Contracts/inbox-write'
import { watchInboxWake } from '../../../Contracts/inbox-wake'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential, refreshSession } from '../session'

const filters: ReadonlyArray<{ value: InboxFilter; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'unread', label: '未读' }, { value: 'system', label: '系统' },
  { value: 'open', label: '进行中' }, { value: 'pending', label: '待处理' }, { value: 'closed', label: '已关闭' },
]
const statuses = ['进行中', '待处理', '已关闭'] as const
const senders = ['你', '管理员', '系统'] as const
const format = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
const filter = ref<InboxFilter>('all')
const rows = shallowRef<readonly InboxListItem[]>([])
const nextPage = ref<string | null>(null)
const selected = ref<bigint | null>(null)
const thread = shallowRef<InboxThread | null>(null)
const listPending = ref(false)
const threadPending = ref(false)
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
const threadHeading = ref<HTMLElement>()
const listHeading = ref<HTMLElement>()
const width = matchMedia('(min-width: 1024px)')
const mobile = ref(!width.matches)
const onWidth = () => { mobile.value = !width.matches }
const hasSelection = computed(() => selected.value !== null)

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

async function loadList(append = false): Promise<boolean> {
  const identity = identityEpoch.value
  const signal = scope.signal
  const session = currentSession.value?.siteSessionId
  const page = append ? nextPage.value : null
  if (!session || !current(signal, identity) || (append && !page)) return false
  const request = ++listRequest
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
    if (request === listRequest) report(failure, signal, identity, '消息列表暂时无法加载。')
    return false
  } finally {
    if (request === listRequest && current(signal, identity)) listPending.value = false
  }
}

async function loadThread(id: bigint, older?: bigint): Promise<boolean> {
  const signal = scope.signal
  const identity = identityEpoch.value
  const session = currentSession.value?.siteSessionId
  if (!session || !current(signal, identity)) return false
  const request = ++threadRequest
  threadPending.value = true
  try {
    const result = await api.inboxThread(id, older, signal, session)
    if (!current(signal, identity) || request !== threadRequest || selected.value !== id) return false
    if (result.id !== id) throw new ProtocolError('Inbox response changed conversation')
    const previous = thread.value
    thread.value = older && previous ? { ...result, readThrough: previous.readThrough,
      messages: [...result.messages, ...previous.messages] } : result
    error.value = ''
    return true
  } catch (failure) {
    if (request === threadRequest) report(failure, signal, identity, '会话暂时无法加载。')
    return false
  } finally {
    if (request === threadRequest && current(signal, identity)) threadPending.value = false
  }
}

function selectConversation(id: bigint, event: MouseEvent) {
  opener = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : undefined
  selected.value = id
  reply.value = replies.get(id)?.body ?? ''
  thread.value = null
  void nextTick(() => threadHeading.value?.focus())
  void loadThread(id)
}

function backToList() {
  selected.value = null
  thread.value = null
  threadPending.value = false
  reply.value = ''
  threadRequest++
  void nextTick(() => (opener?.isConnected ? opener : listHeading.value)?.focus())
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
    notice.value = '工单已提交。'
    opener = undefined
    selected.value = id
    reply.value = replies.get(id)?.body ?? ''
    thread.value = null
    await nextTick(() => threadHeading.value?.focus())
    await Promise.all([loadList(), loadThread(id)])
  } catch (reason) { report(reason, signal, identity, '无法提交工单。请检查内容或稍后重试。') }
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
    notice.value = '回复已发送。'
    await loadList()
  } catch (reason) {
    if (current(signal, identity) && reason instanceof ApiError && reason.status === 409) {
      replies.set(detail.id, { body })
      await loadThread(detail.id)
    }
    report(reason, signal, identity, '回复发送失败。请检查内容或稍后重试。')
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
    report(failure, signal, identity, '无法标记已读，请刷新后重试。')
  } finally {
    if (current(signal, identity)) markPending.value = false
  }
}

async function reloadInbox(fallback?: string) {
  const signal = scope.signal
  const identity = identityEpoch.value
  const id = selected.value
  const resume = await loadList()
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
    } else report(failure, signal, identity, '实时消息暂时无法更新。')
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
  threadPending.value = false
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
  width.addEventListener('change', onWidth)
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('online', resume)
  const signal = scope.signal
  try { if (!currentSession.value) await refreshSession(signal) }
  catch { if (!signal.aborted) error.value = '暂时无法确认登录状态。' }
  finally { checking.value = false }
})

onBeforeUnmount(() => {
  scope.abort()
  clearTimeout(pollTimer)
  width.removeEventListener('change', onWidth)
  document.removeEventListener('visibilitychange', resume)
  window.removeEventListener('online', resume)
})
</script>

<template>
  <main class="inbox-page">
    <ElTaskPageHeader title="我的站内信" density="compact" />
    <RouterLink v-if="currentSession" to="/user/comments">我的评论</RouterLink>
    <p v-if="notice" role="status">{{ notice }}</p>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" show-icon>
      <ElButton v-if="currentSession" text @click="reloadInbox(cursor)">重试</ElButton>
    </ElAlert>
    <ElSkeleton v-if="checking && !currentSession" :rows="5" animated />
    <ElEmptyState v-else-if="!currentSession" title="请先登录">
      <RouterLink to="/login">登录</RouterLink>
    </ElEmptyState>
    <div v-else class="inbox-layout">
      <section v-show="!mobile || !hasSelection" class="inbox-pane" aria-labelledby="inbox-list" :aria-busy="listPending">
        <header class="inbox-pane-heading">
          <h2 id="inbox-list" ref="listHeading" tabindex="-1">消息列表</h2>
          <ElButton v-if="writable" size="small" type="primary" :disabled="sending" @click="composing = !composing">提交工单</ElButton>
          <ElSelect v-model="filter" ariaLabel="筛选消息" class="inbox-filter">
            <ElOption v-for="item in filters" :key="item.value" :label="item.label" :value="item.value" />
          </ElSelect>
        </header>
        <form v-if="composing" class="inbox-composer" @submit.prevent="sendTicket">
          <label for="ticket-subject">主题（选填）</label>
          <ElInput id="ticket-subject" v-model="subject" :disabled="sending" />
          <label for="ticket-body">工单内容</label>
          <ElInput id="ticket-body" v-model="ticket" type="textarea" :autosize="{ minRows: 4, maxRows: 8 }" :disabled="sending" />
          <ElButton type="primary" native-type="submit" :disabled="!ticket.trim()" :loading="sending">发送工单</ElButton>
        </form>
        <ElSkeleton v-if="listPending && !rows.length" :rows="6" animated />
        <ElEmptyState v-else-if="!rows.length && !error" title="没有消息" />
        <ul v-else-if="rows.length" class="inbox-items">
          <li v-for="row in rows" :key="String(row.id)">
            <button type="button" class="inbox-choice" :aria-current="row.id === selected ? 'true' : undefined"
              :disabled="sending" @click="selectConversation(row.id, $event)">
              <strong class="inbox-row-title">{{ row.subject }}</strong>
              <span v-if="row.preview" class="inbox-preview">{{ row.preview }}</span>
              <span class="inbox-meta">
                <template v-if="row.isSystem">系统 · </template>{{ statuses[row.status] }} · {{ format.format(row.lastMessageAt) }}
                <template v-if="row.unreadCount"> · <span>{{ row.unreadCount }} 条未读</span></template>
              </span>
            </button>
          </li>
        </ul>
        <ElButton v-if="nextPage" :loading="listPending" text @click="loadList(true)">加载更多会话</ElButton>
      </section>

      <section v-show="!mobile || hasSelection" class="inbox-pane" aria-labelledby="inbox-thread" :aria-busy="threadPending">
        <header class="inbox-pane-heading">
          <ElButton v-if="mobile && hasSelection" text :disabled="sending" @click="backToList">返回消息列表</ElButton>
          <h2 id="inbox-thread" ref="threadHeading" tabindex="-1">{{ thread?.subject ?? '会话' }}</h2>
          <ElButton v-if="thread?.unreadCount" text :loading="markPending" @click="markRead">标记已读</ElButton>
        </header>
        <ElEmptyState v-if="!hasSelection" title="请选择会话" />
        <ElSkeleton v-else-if="threadPending && !thread" :rows="7" animated />
        <template v-if="thread">
          <p class="inbox-meta">{{ statuses[thread.status] }}</p>
          <ElButton v-if="thread.previous" text :loading="threadPending"
            @click="loadThread(thread.id, thread.previous)">加载更早消息</ElButton>
          <ol class="inbox-items">
            <li v-for="message in thread.messages" :key="String(message.id)" class="inbox-message">
              <p class="inbox-meta">{{ senders[message.sender] }} ·
                <time :datetime="new Date(message.createdAt).toISOString()">{{ format.format(message.createdAt) }}</time>
              </p>
              <p class="inbox-message-text">{{ message.body }}</p>
            </li>
          </ol>
          <form v-if="writable && thread.status !== 2" class="inbox-composer" @submit.prevent="sendReply">
            <label for="reply-body">回复内容</label>
            <ElInput id="reply-body" v-model="reply" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" :disabled="sending" />
            <ElButton type="primary" native-type="submit" :disabled="!reply.trim()" :loading="sending">发送回复</ElButton>
          </form>
        </template>
      </section>
    </div>
  </main>
</template>

<style scoped>
.inbox-page { width: min(83rem, calc(100% - 2 * var(--fsusblog-page-gutter))); margin-inline: auto; padding-block: var(--fsus-space-6) var(--fsus-space-8); }
.inbox-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--fsus-space-8); margin-block-start: var(--fsus-space-6); }
.inbox-pane { min-width: 0; }
.inbox-pane-heading { display: flex; gap: var(--fsus-space-3); align-items: center; justify-content: space-between; padding-block-end: var(--fsus-space-3); border-bottom: 1px solid var(--el-border-color-lighter); }
.inbox-pane-heading h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--el-font-size-large); overflow-wrap: anywhere; }
.inbox-filter { width: min(10rem, 50%); }
.inbox-items { padding: 0; margin: 0; list-style: none; }
.inbox-choice { display: grid; width: 100%; min-width: 0; gap: var(--fsus-space-2); text-align: start; padding: var(--fsus-space-4); background: transparent; color: inherit; font: inherit; border: 0; border-bottom: 1px solid var(--el-border-color-lighter); cursor: pointer; }
.inbox-choice:hover, .inbox-choice[aria-current="true"] { background: var(--el-fill-color-light); }
.inbox-choice[aria-current="true"] { box-shadow: inset 2px 0 var(--el-color-primary); }
.inbox-row-title { overflow-wrap: anywhere; }
.inbox-meta, .inbox-preview { color: var(--el-text-color-secondary); font-size: var(--el-font-size-small); }
.inbox-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inbox-message { padding-block: var(--fsus-space-3); border-bottom: 1px solid var(--el-border-color-lighter); }
.inbox-message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.inbox-composer { display: grid; gap: var(--fsus-space-2); padding-block: var(--fsus-space-4); }
.inbox-composer > button { justify-self: start; }
@media (min-width: 1024px) { .inbox-layout { grid-template-columns: minmax(20rem, 24rem) minmax(0, 1fr); } }
</style>
