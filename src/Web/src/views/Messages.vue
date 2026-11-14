<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ElAlert, ElButton, ElEmptyState, ElOption, ElSelect, ElSkeleton, ElTag, ElTaskPageHeader } from '@ozwasyd/element-plus'
import { api, ApiError, ProtocolError, type InboxFilter, type InboxListItem, type InboxThread } from '../../../Contracts/client'
import { currentSession, identityEpoch, invalidateSession, refreshSession } from '../session'

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
let opener: HTMLButtonElement | undefined

function current(signal: AbortSignal, identity: number) {
  const session = currentSession.value
  return !signal.aborted && identity === identityEpoch.value && session && session.expiresAt > Date.now()
}

function report(failure: unknown, signal: AbortSignal, identity: number, fallback: string) {
  if (!current(signal, identity)) return
  if (failure instanceof ApiError && failure.status === 401) invalidateSession()
  else error.value = fallback
}

async function loadList(append = false): Promise<boolean> {
  const identity = identityEpoch.value
  const signal = scope.signal
  const page = append ? nextPage.value : null
  if (!current(signal, identity) || (append && !page)) return false
  const request = ++listRequest
  listPending.value = true
  try {
    const result = await api.inboxList(filter.value, page ?? undefined, signal)
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
  if (!current(signal, identity)) return false
  const request = ++threadRequest
  threadPending.value = true
  try {
    const result = await api.inboxThread(id, older, signal)
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
  thread.value = null
  void nextTick(() => threadHeading.value?.focus())
  void loadThread(id)
}

function backToList() {
  selected.value = null
  thread.value = null
  threadPending.value = false
  threadRequest++
  void nextTick(() => (opener?.isConnected ? opener : listHeading.value)?.focus())
}

async function markRead() {
  const detail = thread.value
  if (!detail || markPending.value) return
  const signal = scope.signal
  const identity = identityEpoch.value
  if (!current(signal, identity)) return
  markPending.value = true
  try {
    await api.inboxRead(detail.id, detail.readThrough, signal)
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
  if (!current(signal, identity)) return
  try {
    if (document.visibilityState !== 'visible' || listPending.value || markPending.value) return
    if (!cursor) {
      await reloadInbox()
      return
    }
    const previous = cursor
    const page = await api.inboxReplay(previous, signal)
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
    if (current(signal, identity)) pollTimer = setTimeout(() => { void poll(signal, identity) }, 4000)
  }
}

watch(identityEpoch, identity => {
  scope.abort()
  scope = new AbortController()
  clearTimeout(pollTimer)
  selected.value = null
  thread.value = null
  rows.value = []
  nextPage.value = null
  cursor = undefined
  opener = undefined
  error.value = ''
  listPending.value = false
  threadPending.value = false
  markPending.value = false
  if (current(scope.signal, identity)) {
    const signal = scope.signal
    void loadList().then(() => poll(signal, identity))
  }
}, { immediate: true, flush: 'sync' })

watch(filter, () => {
  rows.value = []
  nextPage.value = null
  if (currentSession.value) void loadList()
})

onMounted(async () => {
  width.addEventListener('change', onWidth)
  const signal = scope.signal
  try { if (!currentSession.value) await refreshSession(signal) }
  catch { if (!signal.aborted) error.value = '暂时无法确认登录状态。' }
  finally { checking.value = false }
})

onBeforeUnmount(() => {
  scope.abort()
  clearTimeout(pollTimer)
  width.removeEventListener('change', onWidth)
})
</script>

<template>
  <main class="inbox-page">
    <ElTaskPageHeader title="我的站内信" density="compact" />
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
          <ElSelect v-model="filter" ariaLabel="筛选消息" class="inbox-filter">
            <ElOption v-for="item in filters" :key="item.value" :label="item.label" :value="item.value" />
          </ElSelect>
        </header>
        <ElSkeleton v-if="listPending && !rows.length" :rows="6" animated />
        <ElEmptyState v-else-if="!rows.length && !error" title="没有消息" />
        <ul v-else-if="rows.length" class="inbox-items">
          <li v-for="row in rows" :key="String(row.id)">
            <button type="button" class="inbox-choice" :aria-current="row.id === selected ? 'true' : undefined"
              @click="selectConversation(row.id, $event)">
              <span class="inbox-row-title">
                <strong>{{ row.subject }}</strong>
                <ElTag v-if="row.isSystem" type="info" effect="plain" size="small">系统</ElTag>
                <ElTag v-if="row.unreadCount" type="info" effect="plain" size="small">{{ row.unreadCount }} 条未读</ElTag>
              </span>
              <span v-if="row.preview" class="inbox-preview">{{ row.preview }}</span>
              <span class="inbox-meta">{{ statuses[row.status] }} · {{ format.format(row.lastMessageAt) }}</span>
            </button>
          </li>
        </ul>
        <ElButton v-if="nextPage" :loading="listPending" text @click="loadList(true)">加载更多会话</ElButton>
      </section>

      <section v-show="!mobile || hasSelection" class="inbox-pane" aria-labelledby="inbox-thread" :aria-busy="threadPending">
        <header class="inbox-pane-heading">
          <ElButton v-if="mobile && hasSelection" text @click="backToList">返回消息列表</ElButton>
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
.inbox-row-title { display: flex; align-items: center; flex-wrap: wrap; gap: var(--fsus-space-2); overflow-wrap: anywhere; }
.inbox-meta, .inbox-preview { color: var(--el-text-color-secondary); font-size: var(--el-font-size-small); }
.inbox-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inbox-message { padding-block: var(--fsus-space-3); border-bottom: 1px solid var(--el-border-color-lighter); }
.inbox-message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (min-width: 1024px) { .inbox-layout { grid-template-columns: minmax(20rem, 24rem) minmax(0, 1fr); } }
</style>
