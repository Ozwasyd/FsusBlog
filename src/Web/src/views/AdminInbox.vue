<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { adminInbox, adminInboxThread, type AdminInboxFilter, type AdminInboxRow, type AdminInboxThread } from '../../../Contracts/admin-inbox'

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
const statuses = ['Open', 'Pending', 'Closed'] as const
const senders = ['Account', 'Administrator', 'System'] as const
let operation = new AbortController()
let opener: HTMLElement | undefined

function reset() {
  operation.abort()
  operation = new AbortController()
  rows.value = []
  thread.value = undefined
  next.value = null
  failed.value = ''
  pending.value = false
  opener = undefined
}

function closeThread() {
  thread.value = undefined
  void nextTick(() => { if (opener?.isConnected) opener.focus() })
}

async function read(load: (signal: AbortSignal) => Promise<void>) {
  if (pending.value || props.sessionSignal.aborted) return
  const signal = AbortSignal.any([props.sessionSignal, operation.signal])
  pending.value = true
  failed.value = ''
  try { await load(signal) }
  catch (error) {
    if (signal.aborted) return
    emit('sessionLost', error)
    failed.value = 'Could not read the administrator inbox. Refresh and try again.'
  } finally { if (!signal.aborted) pending.value = false }
}

function loadQueue(cursor: string | null = null) {
  void read(async signal => {
    const page = await adminInbox(filter.value, cursor, signal)
    if (signal.aborted) return
    rows.value = cursor ? [...rows.value, ...page.rows] : page.rows
    next.value = page.next
  })
}

function openThread(id: bigint, before: string | null = null, event?: MouseEvent) {
  if (event?.currentTarget instanceof HTMLElement) opener = event.currentTarget
  void read(async signal => {
    const page = await adminInboxThread(id, before, signal)
    if (signal.aborted) return
    thread.value = before && thread.value?.conversation.id === id
      ? { ...page, messages: [...page.messages, ...thread.value.messages] } : page
    if (!before) void nextTick(() => title.value?.focus())
  })
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
      </section>
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
</style>
