<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  compareDraftRevision, draftRevisionHistory, validRollbackReason, type RevisionHistoryItem,
} from '../../../Contracts/revision-history'
import type { RevisionComparison } from '../../../Contracts/wire.generated'

const props = defineProps<{ articleId: number; revision: bigint; canRollback: boolean }>()
const emit = defineEmits<{ restore: [selection: { sourceRevision: bigint; reason: string }] }>()
const open = ref(false)
const items = shallowRef<readonly RevisionHistoryItem[]>([])
const cursor = ref<string | null>(null)
const published = ref<bigint | null>(null)
const pair = shallowRef<RevisionComparison>()
const reason = ref('')
const error = ref('')
const loading = ref(false)
const comparing = ref(false)
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const allowed = computed(() => !!pair.value && props.canRollback && validRollbackReason(reason.value.trim()))
let historyRequest: AbortController | undefined
let compareRequest: AbortController | undefined

function reset() {
  historyRequest?.abort()
  compareRequest?.abort()
  items.value = []
  cursor.value = null
  published.value = null
  pair.value = undefined
  reason.value = ''
  error.value = ''
  loading.value = false
  comparing.value = false
}

async function load(more = false) {
  if (loading.value || (more && !cursor.value)) return
  const controller = historyRequest = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const result = await draftRevisionHistory(props.articleId, props.revision, controller.signal, more ? cursor.value! : undefined)
    if (controller.signal.aborted) return
    items.value = more ? [...items.value, ...result.items] : result.items
    published.value = result.publishedRevision
    cursor.value = result.nextCursor
  } catch (cause) {
    if (!controller.signal.aborted) {
      if (more && cause instanceof ApiError && cause.status === 400) {
        reset()
        error.value = 'The revision page expired. Reload revisions.'
      } else {
        requestError(cause)
      }
    }
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}

async function compare(source: bigint) {
  compareRequest?.abort()
  const controller = compareRequest = new AbortController()
  comparing.value = true
  error.value = ''
  reason.value = ''
  pair.value = undefined
  try {
    const result = await compareDraftRevision(props.articleId, props.revision, source, controller.signal)
    if (!controller.signal.aborted) pair.value = result
  } catch (cause) {
    if (!controller.signal.aborted) requestError(cause)
  } finally {
    if (!controller.signal.aborted) comparing.value = false
  }
}

function requestError(cause: unknown) {
  if (cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
    reset()
    error.value = cause.status === 409 ? 'Load the current draft to view revision history.' : 'Revision history is unavailable.'
  } else {
    error.value = 'Could not load the revision. Try again.'
  }
}

function toggle(event: Event) {
  open.value = (event.currentTarget as HTMLDetailsElement).open
}

function restore() {
  if (allowed.value && pair.value)
    emit('restore', { sourceRevision: pair.value.sourceRevision, reason: reason.value.trim() })
}

watch(() => [open.value, props.articleId, props.revision], () => {
  reset()
  if (open.value && props.articleId > 0) void load()
}, { flush: 'sync' })
onScopeDispose(() => {
  historyRequest?.abort()
  compareRequest?.abort()
})
</script>

<template>
  <details class="revision-history" @toggle="toggle">
    <summary>Revision history</summary>
    <p v-if="loading || comparing" role="status">{{ comparing ? 'Loading comparison…' : 'Loading revisions…' }}</p>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <ElButton v-if="error && !items.length" text @click="load()">Reload revisions</ElButton>
    <ul class="revision-items">
      <li v-for="item in items" :key="item.revision.toString()">
        <div>{{ item.title }} · Revision {{ item.revision }}</div>
        <small>
          {{ date.format(item.savedAt) }}
          <span v-if="item.revision === props.revision"> · Current draft</span>
          <span v-if="item.revision === published"> · Published</span>
        </small>
        <p v-if="item.sourceRevision">Restored from revision {{ item.sourceRevision }}. {{ item.reason }}</p>
        <ElButton v-if="item.revision < props.revision" text @click="compare(item.revision)">
          Compare revision {{ item.revision }}
        </ElButton>
      </li>
    </ul>
    <ElButton v-if="cursor" :disabled="loading" text @click="load(true)">Older revisions</ElButton>
    <section v-if="pair" class="revision-comparison" aria-label="Revision comparison">
      <h3>Revision {{ pair.sourceRevision }} compared with revision {{ pair.revision }}</h3>
      <details>
        <summary>Current draft · {{ pair.title }}</summary>
        <pre>{{ pair.body }}</pre>
      </details>
      <details open>
        <summary>Earlier revision · {{ pair.sourceTitle }}</summary>
        <pre>{{ pair.sourceBody }}</pre>
      </details>
      <label for="revision-rollback-reason">Reason for restoring this draft</label>
      <ElInput id="revision-rollback-reason" v-model="reason" />
      <p>Use 8 to 500 characters. This restores the title, content and classification. Publishing stays a separate step.</p>
      <p v-if="!props.canRollback">Save pending changes before restoring a revision.</p>
      <ElButton :disabled="!allowed" @click="restore">Restore as new draft</ElButton>
    </section>
  </details>
</template>

<style scoped>
.revision-history summary { cursor: pointer; }
.revision-items { list-style: none; margin: .75rem 0 0; padding: 0; }
.revision-items > li { padding: .5rem 0; overflow-wrap: anywhere; }
.revision-comparison { display: grid; gap: .6rem; }
.revision-comparison h3, .revision-comparison p { margin: 0; }
.revision-comparison pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 16rem; overflow: auto; }
</style>
