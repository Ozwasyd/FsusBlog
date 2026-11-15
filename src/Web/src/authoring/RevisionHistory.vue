<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, useId, watch } from 'vue'
import { ElAlert, ElButton, ElCheckbox, ElDialog, ElInput } from '@ozwasyd/element-plus'
import { ApiError } from '../../../Contracts/aeds'
import {
  compareDraftRevision, compareRevisionMetadata, draftRevisionHistory, validRollbackReason, type RevisionHistoryItem,
} from '../../../Contracts/revision-history'
import { draftSummary, type DraftSummaryEdit } from '../../../Contracts/article-summary-client'
import type { ArticleTaxonomy } from '../../../Contracts/author-articles'
import type { Draft, RevisionComparison } from '../../../Contracts/wire.generated'
import MarkdownExportControl from './MarkdownExportControl.vue'
import DocumentExportTasks from './DocumentExportTasks.vue'
import RevisionPropertyPage from './RevisionPropertyPage.vue'
import { credentialEpoch, currentSession, identityEpoch } from '../session'
import type { HistoricalSearchSeek } from './canvasEditorHandoff'
import { textareaSourceRange, verifySourceMatch } from './sourceCoordinates'

const props = defineProps<{
  articleId: number
  revision: bigint
  canRollback: boolean
  historicalSeek?: HistoricalSearchSeek
  inspectorReady: boolean
  editorDraft?: Draft
  editorSummary?: DraftSummaryEdit
  editorTaxonomy?: { articleId: number; revision: bigint; identity: number; category: ArticleTaxonomy | null; tags: ArticleTaxonomy[] }
}>()
const emit = defineEmits<{
  restore: [selection: { sourceRevision: bigint; reason: string }]
  'comparison-modal': [active: boolean]
  'historical-revealed': [seek: HistoricalSearchSeek, success: boolean]
  'historical-closed': [seek: HistoricalSearchSeek]
}>()
const open = ref(false)
const items = shallowRef<readonly RevisionHistoryItem[]>([])
const cursor = ref<string | null>(null)
const published = ref<bigint | null>(null)
const pair = shallowRef<RevisionComparison>()
const pairCredential = ref<string>()
const compareEditor = ref(false)
const historical = shallowRef<{ seek: HistoricalSearchSeek; source: string }>()
const historicalControl = ref<HTMLTextAreaElement>()
const historicalLabel = {
  title: 'Earlier revision title',
  body: 'Earlier revision Markdown',
  summary: 'Earlier revision summary',
  heading: 'Earlier revision Markdown',
} as const
const comparisonOpen = ref(false)
const propertiesOpen = ref(false)
const metadataOpen = ref(false)
const metadata = shallowRef<Awaited<ReturnType<typeof compareRevisionMetadata>>>()
const metadataFailure = ref('')
let ownsModal = false
const comparisonError = ref('')
const reason = ref('')
const error = ref('')
const loading = ref(false)
const comparing = ref(false)
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const allowed = computed(() => !!pair.value && props.canRollback && validRollbackReason(reason.value.trim()))
const compareId = useId()
const editor = computed(() => {
  const live = props.editorDraft
  return pair.value && live?.id === pair.value.id && live.revision === pair.value.revision &&
    pairCredential.value && currentSession.value?.siteSessionId === pairCredential.value ? live : undefined
})
const usingEditor = computed(() => compareEditor.value && !!editor.value)
const sources = computed(() => {
  const saved = pair.value
  if (!saved) return []
  const current = usingEditor.value && editor.value ? editor.value : saved
  return [
    { key: 'earlier', label: 'Earlier revision', coordinate: String(saved.sourceRevision), title: saved.sourceTitle, body: saved.sourceBody },
    { key: 'current', label: usingEditor.value ? 'Current editor' : 'Current saved revision',
      coordinate: usingEditor.value ? `Based on saved revision ${saved.revision}` : String(saved.revision), title: current.title, body: current.body },
  ]
})
const changed = computed(() => {
  const [earlier, current] = sources.value
  if (earlier && current) return {
    title: earlier.title !== current.title, body: earlier.body !== current.body,
    markdownDelta: earlier.body.length - current.body.length,
  }
})
const comparisonMetadata = computed(() => {
  const saved = metadata.value
  const live = editor.value
  if (!saved || !usingEditor.value || !live) return saved
  const summary = props.editorSummary
  const taxonomy = props.editorTaxonomy
  const current = { ...saved.current }
  if (summary?.articleId === live.id && summary.revision === live.revision && summary.credential === pairCredential.value)
    current.summary = summary.text
  if (taxonomy?.articleId === live.id && taxonomy.revision === live.revision && taxonomy.identity === identityEpoch.value) {
    current.category = taxonomy.category
    current.tags = taxonomy.tags
  }
  return { source: saved.source, current }
})
const metadataChanges = computed(() => {
  if (!comparisonMetadata.value) return ''
  const { source, current } = comparisonMetadata.value
  const tags = (item: typeof source) => item.tags.map(tag => tag.id).join(',')
  return [source.summary !== current.summary ? 'Summary changed.' : 'Summary unchanged.',
    source.category?.id !== current.category?.id ? 'Category changed.' : 'Category unchanged.',
    tags(source) !== tags(current) ? 'Tags changed.' : 'Tags unchanged.',
    !source.cover && !current.cover ? '' : source.cover === current.cover ? 'Cover unchanged.' : 'Cover changed.'].filter(Boolean).join(' ')
})
let historyRequest: AbortController | undefined
let compareRequest: AbortController | undefined

function reset() {
  historyRequest?.abort()
  closeComparison()
  items.value = []
  cursor.value = null
  published.value = null
  error.value = ''
  loading.value = false
}

function closeComparison() {
  const source = historical.value
  comparisonOpen.value = false
  propertiesOpen.value = false
  metadataOpen.value = false
  compareRequest?.abort()
  pair.value = undefined
  pairCredential.value = undefined
  compareEditor.value = false
  historical.value = undefined
  reason.value = ''
  comparisonError.value = ''
  comparing.value = false
  if (source) emit('historical-closed', source.seek)
}

function releaseComparisonModal() {
  if (!ownsModal) return
  ownsModal = false
  emit('comparison-modal', false)
}

function openComparisonModal() {
  if (!ownsModal) {
    ownsModal = true
    emit('comparison-modal', true)
  }
  comparisonOpen.value = true
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
  propertiesOpen.value = false
  metadataOpen.value = false
  const controller = compareRequest = new AbortController()
  openComparisonModal()
  comparing.value = true
  comparisonError.value = ''
  reason.value = ''
  pair.value = undefined
  pairCredential.value = undefined
  compareEditor.value = false
  const session = currentSession.value?.siteSessionId
  try {
    const result = await compareDraftRevision(props.articleId, props.revision, source, controller.signal, session)
    if (!controller.signal.aborted) {
      pairCredential.value = session
      pair.value = result
    }
  } catch (cause) {
    if (controller.signal.aborted) return
    if (cause instanceof ApiError && [401, 403, 409].includes(cause.status)) {
      historyRequest?.abort()
      items.value = []
      cursor.value = null
      published.value = null
      loading.value = false
      error.value = cause.status === 409 ? 'Load the current draft to view revision history.' : 'Revision history is unavailable.'
      comparisonError.value = cause.status === 409 ? 'The saved draft changed. Load its current revision and compare again.' : 'This comparison is unavailable.'
    } else {
      comparisonError.value = cause instanceof ApiError && cause.status === 404
        ? 'The selected revision is unavailable.'
        : 'Could not load both revisions. Close the comparison and try again.'
    }
  } finally {
    if (!controller.signal.aborted) comparing.value = false
  }
}

watch([metadataOpen, pair, credentialEpoch], async ([show, selected], _, cleanup) => {
  metadata.value = undefined
  metadataFailure.value = ''
  if (!show || !selected) return
  const session = currentSession.value?.siteSessionId
  if (!session) {
    metadataFailure.value = 'A current author session is required for saved metadata.'
    return
  }
  const controller = new AbortController()
  cleanup(() => controller.abort())
  try {
    const fields = await compareRevisionMetadata(selected.id, selected.revision, selected.sourceRevision, session, controller.signal)
    if (!controller.signal.aborted) metadata.value = fields
  } catch (cause) {
    if (!controller.signal.aborted) metadataFailure.value = cause instanceof ApiError && cause.status === 409
      ? 'The saved draft or session changed. Reopen the comparison.' : 'Saved metadata is unavailable.'
  }
}, { flush: 'sync' })

async function readHistoricalSource(seek: HistoricalSearchSeek, signal: AbortSignal) {
  const { target, currentRevision, credential } = seek
  if (target.field === 'summary') {
    const summary = await draftSummary(target.articleId, currentRevision, credential, signal, target.revision)
    return summary.text
  }
  const pair = await compareDraftRevision(target.articleId, currentRevision, target.revision, signal, credential)
  return target.field === 'title' ? pair.sourceTitle : pair.sourceBody
}

function revealHistorical() {
  const view = historical.value
  if (!view) return
  const { seek, source } = view
  const input = historicalControl.value
  const { sourceStart: start, sourceEnd: end } = seek.target
  const range = input && seek.current() && textareaSourceRange(source, input.value, { start, end }, 'native')
  let success = false
  if (input && range && input.isConnected && input.readOnly && !input.closest('[inert]') && input.getClientRects().length) {
    input.focus()
    if (document.activeElement === input && seek.current()) {
      input.setSelectionRange(range.start, range.end)
      success = input.selectionStart === range.start && input.selectionEnd === range.end
    }
  }
  emit('historical-revealed', seek, success)
}

watch([() => props.historicalSeek, () => props.inspectorReady], async ([seek, inspectorReady], _, cleanup) => {
  if (!seek || !inspectorReady) return
  const request = new AbortController()
  cleanup(() => {
    request.abort()
    if (historical.value?.seek === seek) closeComparison()
  })
  const current = () => !request.signal.aborted && props.historicalSeek === seek && seek.current() && props.inspectorReady &&
    props.articleId === seek.target.articleId && props.revision === seek.currentRevision && !ownsModal
  try {
    if (current()) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
      const source = await readHistoricalSource(seek, signal)
      if (current() && await verifySourceMatch(source, seek.target) && current() && !signal.aborted) {
        historical.value = { seek, source }
        openComparisonModal()
        return
      }
    }
  } catch {
    // An inaccessible or changed source is never mounted in the dialog.
  }
  if (!request.signal.aborted && props.historicalSeek === seek) emit('historical-revealed', seek, false)
}, { immediate: true, flush: 'post' })

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
  if (!allowed.value || !pair.value) return
  const selection = { sourceRevision: pair.value.sourceRevision, reason: reason.value.trim() }
  closeComparison()
  emit('restore', selection)
}

watch(() => [open.value, props.articleId, props.revision], () => {
  reset()
  if (open.value && props.articleId > 0) void load()
}, { flush: 'sync' })
watch(credentialEpoch, () => {
  historyRequest?.abort()
  compareRequest?.abort()
  compareEditor.value = false
  pairCredential.value = undefined
  if (historical.value) closeComparison()
  if (comparisonOpen.value && comparing.value) {
    comparing.value = false
    comparisonError.value = 'The session renewed while loading. Close the comparison and try again.'
  }
  items.value = []
  cursor.value = null
  published.value = null
  loading.value = false
  if (open.value && props.articleId > 0) void load()
}, { flush: 'sync' })
onScopeDispose(() => {
  historyRequest?.abort()
  compareRequest?.abort()
  releaseComparisonModal()
})
</script>

<template>
  <details class="revision-history" @toggle="toggle">
    <summary>Revision history</summary>
    <p v-if="loading" role="status">Loading revisions…</p>
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
        <ElButton v-if="item.revision < props.revision" text v-bind="{ 'aria-haspopup': 'dialog' }" @click="compare(item.revision)">
          Compare revision {{ item.revision }}
        </ElButton>
      </li>
    </ul>
    <ElButton v-if="cursor" :disabled="loading" text @click="load(true)">Older revisions</ElButton>
    <ElDialog
      :model-value="comparisonOpen" :title="historical ? 'Historical search position' : 'Revision comparison'" append-to-body destroy-on-close
      width="min(72rem, calc(100vw - 2rem))" top="4vh"
      @opened="revealHistorical"
      @close="closeComparison"
      @closed="releaseComparisonModal"
    >
      <section v-if="historical" class="revision-comparison">
        <p>Earlier saved revision {{ historical.seek.target.revision }}</p>
        <textarea ref="historicalControl" class="historical-source" :value="historical.source"
          :aria-label="historicalLabel[historical.seek.target.field]" readonly rows="8" />
      </section>
      <p v-if="comparing" role="status">Loading both saved revisions…</p>
      <ElAlert v-if="comparisonError" :title="comparisonError" type="error" :closable="false" />
      <div v-if="pair && changed" class="revision-comparison">
        <ElCheckbox v-if="editor" :model-value="compareEditor" @update:model-value="compareEditor = $event === true">Compare with current editor</ElCheckbox>
        <p>{{ changed.title ? 'Title changed.' : 'Title unchanged.' }} {{ changed.body ? 'Markdown changed.' : 'Markdown unchanged.' }}</p>
        <p v-if="changed.body">Earlier Markdown length difference (UTF-16): {{ changed.markdownDelta > 0 ? '+' : '' }}{{ changed.markdownDelta }}</p>
        <div class="revision-sources">
          <section v-for="source in sources" :key="source.key" class="revision-source" :aria-labelledby="`${compareId}-${source.key}`">
            <h3 :id="`${compareId}-${source.key}`">{{ source.label }} · {{ source.coordinate }}</h3>
            <p>{{ source.title }}</p>
            <pre tabindex="0" :aria-label="`${source.label} Markdown`">{{ source.body }}</pre>
          </section>
        </div>
        <details @toggle="metadataOpen = ($event.currentTarget as HTMLDetailsElement).open">
          <summary>{{ usingEditor ? 'Summary and classification' : 'Saved summary and classification' }}</summary>
          <p v-if="metadataOpen && !metadata && !metadataFailure" role="status">Loading saved metadata…</p>
          <p v-if="metadataFailure" role="alert">{{ metadataFailure }}</p>
          <template v-if="comparisonMetadata">
            <p>{{ metadataChanges }}</p>
            <div class="revision-sources">
              <section v-for="(fields, index) in [comparisonMetadata.source, comparisonMetadata.current]" :key="index" class="revision-source">
                <h4>{{ sources[index].label }}</h4>
                <dl class="revision-metadata">
                  <dt>Summary</dt><dd>{{ fields.summary || 'No saved summary' }}</dd>
                  <dt>Category</dt><dd>{{ fields.category?.name ?? 'No category' }}</dd>
                  <dt>Tags</dt><dd>{{ fields.tags.map(tag => tag.name).join(', ') || 'No tags' }}</dd>
                  <template v-if="comparisonMetadata.source.cover || comparisonMetadata.current.cover">
                    <dt>Cover</dt><dd>{{ fields.cover ? `Private image ${fields.cover}` : 'No draft cover' }}</dd>
                  </template>
                </dl>
              </section>
            </div>
          </template>
        </details>
        <details @toggle="propertiesOpen = ($event.currentTarget as HTMLDetailsElement).open">
          <summary>Saved properties</summary>
          <div v-if="propertiesOpen" class="revision-sources">
            <RevisionPropertyPage :article-id="pair.id" :revision="pair.revision" :source-revision="pair.sourceRevision"
              label="Earlier saved properties" />
            <RevisionPropertyPage :article-id="pair.id" :revision="pair.revision" :source-revision="pair.revision"
              label="Current saved properties" />
          </div>
        </details>
        <MarkdownExportControl :article="props.articleId" :revision="props.revision" :selected="pair.sourceRevision" />
        <MarkdownExportControl :article="props.articleId" :revision="props.revision" :selected="pair.sourceRevision" format="docx" />
        <MarkdownExportControl :article="props.articleId" :revision="props.revision" :selected="pair.sourceRevision" format="html" />
        <MarkdownExportControl :article="props.articleId" :revision="props.revision" :selected="pair.sourceRevision" format="epub" />
        <MarkdownExportControl :article="props.articleId" :revision="props.revision" :selected="pair.sourceRevision" format="pdf" />
        <DocumentExportTasks :article="props.articleId" :revision="props.revision" :selected="pair.sourceRevision"
          :active="comparisonOpen" />
        <label :for="`${compareId}-reason`">Reason for restoring this draft</label>
        <ElInput :id="`${compareId}-reason`" v-model="reason" />
        <p>Use 8 to 500 characters. Restoring copies the selected title, Markdown, classification, private attachments, draft cover, and rights policy into a new draft.</p>
        <p v-if="!props.canRollback">Save pending changes before restoring a revision.</p>
        <ElButton :disabled="!allowed" @click="restore">Restore as new draft</ElButton>
      </div>
    </ElDialog>
  </details>
</template>

<style scoped>
.revision-history summary { cursor: pointer; }
.revision-items { list-style: none; margin: .75rem 0 0; padding: 0; }
.revision-items > li { padding: .5rem 0; overflow-wrap: anywhere; }
.revision-comparison { display: grid; gap: .6rem; }
.historical-source {
  box-sizing: border-box;
  inline-size: 100%;
  max-block-size: min(55dvh, 24rem);
  padding: .65rem;
  color: var(--fsus-ink);
  background: var(--fsus-paper);
  border: 1px solid var(--fsus-border);
  font: inherit;
}
.revision-comparison p, .revision-source h3 { margin: 0; }
.revision-sources { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--fsus-space-4); }
.revision-source {
  min-inline-size: 0;
  padding: var(--fsus-space-3);
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-control);
  overflow-wrap: anywhere;
}
.revision-source h3 { font-size: 1rem; }
.revision-metadata dd { margin-inline-start: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.revision-source pre {
  white-space: pre-wrap;
  max-block-size: min(40dvh, 24rem);
  overflow: auto;
  overscroll-behavior: contain;
  margin-block: var(--fsus-space-2) 0;
}
@media (max-width: 740px) {
  .revision-sources { grid-template-columns: minmax(0, 1fr); }
}
</style>
