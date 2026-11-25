<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { ElAlert, ElButton, ElOption, ElSelect } from '@ozwasyd/element-plus'
import { ApiError, ProtocolError } from '../../../Contracts/aeds'
import {
  cancelDocumentExportTask, createDocumentExportTask, downloadDocumentExportTask, listDocumentExportTasks,
  readExportFormattingReceipt, hasExportWarnings, documentWarningLabels, type DocumentExportWarning,
  type DocumentExportFailure, type DocumentExportFormat, type DocumentExportStatus, type DocumentExportTask,
} from '../../../Contracts/document-export-tasks'
import { credentialEpoch, currentSession, identityEpoch, recheckCredential } from '../authorSession'

const props = defineProps<{ article: number; revision: bigint; selected: bigint; active: boolean; disabled?: boolean }>()
const enabled = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-document-export-tasks"]')?.content === '1'
const pdfAvailable = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-pdf-export"]')?.content === '1'
const formats: readonly DocumentExportFormat[] = pdfAvailable ? ['html', 'pdf', 'docx', 'epub'] : ['html', 'docx', 'epub']
const labels: Record<DocumentExportFormat, string> = { html: 'HTML', pdf: 'PDF', docx: 'Word', epub: 'EPUB' }
const states: Record<DocumentExportStatus, string> = {
  get queued() { return t('author.documentExportTasks.queued') }, get running() { return t('author.documentExportTasks.running') }, get succeeded() { return t('author.documentExportTasks.ready') }, get failed() { return t('author.documentExportTasks.failed') }, get cancelled() { return t('author.documentExportTasks.cancelled') },
  get blocked() { return t('author.documentExportTasks.blocked') }, get cancelling() { return t('author.documentExportTasks.cancelling') },
}
const failures: Record<DocumentExportFailure, string> = {
  none: '', get 'unsupported-input'() { return t('author.documentExportTasks.this.revision.exceeds.the.format.limits.or.contains.unsupported') },
  get 'provider-unavailable'() { return t('author.documentExportTasks.this.format.is.currently.unavailable') }, get permission() { return t('author.documentExportTasks.the.saved.revision.is.no.longer.available') },
  get interruption() { return t('author.documentExportTasks.the.export.was.interrupted') },
}
const open = ref(false)
const loading = ref(false)
const busy = ref(false)
const loaded = ref(false)
const now = ref(Date.now())
const listError = ref('')
const actionError = ref('')
const format = ref<DocumentExportFormat>('html')
const tasks = shallowRef<readonly DocumentExportTask[]>([])
const formattingWarnings = shallowRef<{ id: string; items: DocumentExportWarning[] }>()
const eligible = computed(() => enabled && !!currentSession.value?.canAuthor && !!currentSession.value?.siteSessionId)
const visible = computed(() => eligible.value && props.active && open.value)
const createKeys = new Map<DocumentExportFormat, string>()
let request: { kind: 'list' | 'action'; controller: AbortController } | undefined
let timer: ReturnType<typeof setTimeout> | undefined

function cancelable(task: DocumentExportTask) {
  return task.status === 'queued' || task.status === 'running'
}

function downloadable(task: DocumentExportTask, time = now.value) {
  return task.status === 'succeeded' && task.expiresUnixMs > BigInt(time)
}

function stop() {
  clearTimeout(timer)
  request?.controller.abort()
  request = undefined
  loading.value = busy.value = loaded.value = false
  tasks.value = []
  formattingWarnings.value = undefined
  listError.value = actionError.value = ''
}

function refreshWhenNeeded() {
  clearTimeout(timer)
  if (!visible.value || request) return
  if (!listError.value && tasks.value.some(task => cancelable(task) || task.status === 'cancelling')) {
    timer = setTimeout(() => { void load() }, 2000)
    return
  }
  const remaining = tasks.value
    .filter(task => downloadable(task))
    .map(task => Number(task.expiresUnixMs) - now.value)
  if (remaining.length) {
    timer = setTimeout(() => { now.value = Date.now(); refreshWhenNeeded() },
      Math.min(2_147_483_647, ...remaining))
  }
}

async function run(kind: 'list' | 'action', work: (handle: string, signal: AbortSignal, current: () => boolean) => Promise<void>) {
  const session = currentSession.value
  const handle = session?.siteSessionId
  if (!visible.value || !session || !handle || session.expiresAt <= Date.now() ||
      (request && (kind === 'list' || request.kind === 'action'))) return
  request?.controller.abort()
  clearTimeout(timer)
  const controller = new AbortController()
  const operation = request = { kind, controller }
  const { article, revision, selected } = props
  const identity = identityEpoch.value
  const credential = credentialEpoch.value
  const current = () => !controller.signal.aborted && request === operation && visible.value &&
    identity === identityEpoch.value && credential === credentialEpoch.value &&
    article === props.article && revision === props.revision && selected === props.selected &&
    currentSession.value?.siteSessionId === handle && currentSession.value.expiresAt > Date.now()
  loading.value = kind === 'list'
  busy.value = kind === 'action'
  const error = kind === 'list' ? listError : actionError
  error.value = ''
  try {
    await work(handle, controller.signal, current)
  } catch (cause) {
    if (!current()) return
    if (cause instanceof ApiError && cause.status === 401) await recheckCredential(handle, controller.signal)
    if (!current()) return
    error.value = cause instanceof ApiError && cause.status === 409
      ? t('author.documentExportTasks.the.draft.or.export.task.changed.refresh.tasks.or')
      : cause instanceof ApiError && [401, 403, 404, 410].includes(cause.status)
        ? t('author.documentExportTasks.this.export.is.no.longer.available')
        : kind === 'list' ? t('author.documentExportTasks.could.not.load.export.tasks.try.refreshing') : t('author.documentExportTasks.could.not.complete.the.export.request.try.again')
  } finally {
    if (request === operation) {
      request = undefined
      loading.value = busy.value = false
      now.value = Date.now()
      refreshWhenNeeded()
    }
  }
}

async function load() {
  await run('list', async (handle, signal, current) => {
    const result = await listDocumentExportTasks(props.article, handle, signal)
    if (!current()) return
    tasks.value = result
    for (const [format, id] of createKeys) {
      if (result.some(task => task.id === id)) createKeys.delete(format)
    }
    loaded.value = true
  })
}

function record(task: DocumentExportTask) {
  const present = tasks.value.findIndex(item => item.id === task.id)
  tasks.value = present === -1 ? [task, ...tasks.value].slice(0, 4) :
    tasks.value.map(item => item.id === task.id ? task : item)
  listError.value = ''
  loaded.value = true
}

async function create() {
  if (!visible.value || busy.value || props.disabled || !formats.includes(format.value)) return
  const selectedFormat = format.value
  const id = createKeys.get(selectedFormat) ?? crypto.randomUUID()
  createKeys.set(selectedFormat, id)
  await run('action', async (handle, signal, current) => {
    const task = await createDocumentExportTask({
      id, article: props.article, revision: props.revision, sourceRevision: props.selected, format: selectedFormat,
    }, handle, signal)
    if (!current()) return
    createKeys.delete(selectedFormat)
    record(task)
  })
}

async function cancel(task: DocumentExportTask) {
  if (!cancelable(task)) return
  await run('action', async (handle, signal, current) => {
    const result = await cancelDocumentExportTask(task.id, handle, signal)
    if (!current()) return
    if (result.article !== task.article || result.revision !== task.revision ||
        result.sourceRevision !== task.sourceRevision || result.format !== task.format)
      throw new ProtocolError('Unexpected document export coordinates')
    record(result)
  })
}

async function download(task: DocumentExportTask, action: 'export' | 'receipt' | 'review' = 'export') {
  if (!downloadable(task, Date.now())) return
  await run('action', async (handle, signal, current) => {
    const details = hasExportWarnings(task.format) && action !== 'export' ? await readExportFormattingReceipt(task, handle, signal) : undefined
    const blob = details?.file ?? await downloadDocumentExportTask(task, handle, signal, action === 'receipt')
    if (!current() || !downloadable(task, Date.now())) return
    if (details) formattingWarnings.value = { id: task.id, items: details.warnings }
    if (action === 'review') return
    const url = URL.createObjectURL(blob)
    try {
      const link = document.createElement('a')
      link.href = url
      link.download = action === 'receipt' ? 'article.export-receipt.json' : `article.${task.format}`
      link.click()
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  })
}

function toggle(event: Event) {
  if (event.currentTarget instanceof HTMLDetailsElement) open.value = event.currentTarget.open
}

watch(eligible, allowed => { if (!allowed) open.value = false }, { flush: 'sync' })
watch([() => props.article, () => props.revision, () => props.selected, identityEpoch], () => createKeys.clear(), { flush: 'sync' })
watch([() => props.article, () => props.revision, () => props.selected, credentialEpoch, visible], () => {
  stop()
  if (visible.value) void load()
}, { flush: 'sync' })
onScopeDispose(stop)
</script>

<template>
  <details v-if="eligible" class="document-export-tasks" @toggle="toggle">
    <summary>{{ t('author.documentExportTasks.document.export.tasks') }}</summary>
    <div v-if="open" class="document-export-content" role="region" :aria-label="t('author.documentExportTasks.document.export.tasks')">
      <p>{{ t('author.documentExportTasks.source.revision', { p0: String(selected) }) }}</p>
      <div class="document-export-controls">
        <div class="document-export-format">
          <ElSelect v-model="format" :ariaLabel="t('author.documentExportTasks.export.format')" :disabled="disabled || busy">
            <ElOption v-for="value in formats" :key="value" :value="value" :label="labels[value]" />
          </ElSelect>
        </div>
        <ElButton native-type="button" :disabled="disabled || busy" @click="create">{{ t('author.documentExportTasks.create.export.task') }}</ElButton>
        <ElButton native-type="button" text :disabled="loading || busy" @click="load">{{ t('author.documentExportTasks.refresh.tasks') }}</ElButton>
      </div>
      <p v-if="loading && !loaded" role="status">{{ t('author.documentExportTasks.loading.export.tasks') }}</p>
      <p v-else-if="loaded && !tasks.length" role="status">{{ t('author.documentExportTasks.no.export.tasks.for.this.article') }}</p>
      <ElAlert v-if="listError" :title="listError" type="error" :closable="false" />
      <ElAlert v-if="actionError" :title="actionError" type="error" :closable="false" />
      <ul v-if="tasks.length" class="document-export-list" :aria-label="t('author.documentExportTasks.recent.export.tasks')">
        <li v-for="task in tasks" :key="task.id">
          <strong>{{ t('author.revisionHistory.revision', { p0: String(labels[task.format]), p1: String(task.sourceRevision) }) }}</strong>
          <span role="status">{{ task.status === 'succeeded' && !downloadable(task) ? t('admin.sessionExpired') : states[task.status] }}</span>
          <span v-if="task.failure !== 'none'">{{ failures[task.failure] }}</span>
          <div v-if="cancelable(task) || downloadable(task)">
            <ElButton v-if="cancelable(task)" native-type="button" text :disabled="busy" @click="cancel(task)">{{ t('author.documentExportTasks.cancel.task') }}</ElButton>
            <template v-if="downloadable(task)">
              <ElButton native-type="button" text :disabled="busy" @click="download(task)">{{ t('author.documentExportTasks.download.export') }}</ElButton>
              <ElButton native-type="button" text :disabled="busy" @click="download(task, 'receipt')">{{ t('author.documentExportTasks.download.receipt') }}</ElButton>
              <ElButton v-if="hasExportWarnings(task.format)" native-type="button" text :disabled="busy" @click="download(task, 'review')">{{ t('author.documentExportTasks.review.formatting', { p0: String(labels[task.format]) }) }}</ElButton>
            </template>
          </div>
          <div v-if="downloadable(task) && formattingWarnings?.id === task.id" role="status">
            <ul v-if="formattingWarnings.items.length">
              <li v-for="warning in formattingWarnings.items" :key="warning.code">
                {{ documentWarningLabels[warning.code] }} ({{ warning.occurrences }})
              </li>
            </ul>
            <p v-else>{{ t('author.documentExportTasks.no.formatting.warnings.were.reported', { p0: String(labels[task.format]) }) }}</p>
          </div>
        </li>
      </ul>
    </div>
  </details>
</template>

<style scoped>
.document-export-tasks summary { cursor: pointer; }
.document-export-content { display: grid; gap: var(--fsus-space-2); padding-block: var(--fsus-space-2); }
.document-export-content p { margin: 0; }
.document-export-controls { display: flex; align-items: center; flex-wrap: wrap; gap: var(--fsus-space-2); }
.document-export-format { inline-size: 8rem; max-inline-size: 100%; }
.document-export-list { list-style: none; margin: 0; padding: 0; }
.document-export-list li { display: grid; gap: var(--fsus-space-1); padding-block: var(--fsus-space-2); border-block-start: 1px solid var(--fsus-border); }
</style>
