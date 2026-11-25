<script setup lang="ts">
import { t } from '../siteLocale'
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import {
  createMarkdownOutlineModel, defaultMarkdownEditorCommands, ElAlert, ElButton, ElInput, ElMarkdownEditor,
  resolveMarkdownOutlineActive, type MarkdownEditorMode, type MarkdownEditorOutlineItem,
  type MarkdownEditorSelectionEvent, type MarkdownEditorTransactionEvent,
} from '@ozwasyd/element-plus'
import type { Draft } from '../../../Contracts/client'
import type { BodyEdit } from '../../../Contracts/article-body-insertion'
import { WireLimits } from '../../../Contracts/wire.generated'
import ArticleOutlineRail from './ArticleOutlineRail.vue'
import type { EditorSourceSeek } from './canvasEditorHandoff'
import { hasUniformCrlf, normalizeCrlf, restoreCrlf, textareaSourceRange, verifySourceMatch } from './sourceCoordinates'
import { captureBodyEdits } from './savedBodyInsertion'
import type { WorkspaceSource } from './workspaceRegistry'

const props = defineProps<{
  pane: WorkspaceSource<Draft>
  focus: boolean
  blocked: boolean
  split: boolean
  canSwitch: boolean
  concealed: boolean
  sourceTarget?: EditorSourceSeek
  outlineLauncherTarget?: HTMLElement
  outlineDockTarget?: HTMLElement
  outlineFallbackOpener?: () => HTMLElement | null
}>()
const emit = defineEmits<{
  edit: [field: 'title' | 'body', value: string, edits?: readonly BodyEdit[]]
  activate: []
  compose: [active: boolean]
  sourceRevealed: [target: EditorSourceSeek, success: boolean]
  outlineVisibility: [open: boolean]
}>()
const nativeMarkdown = import.meta.env.FSUS_MARKDOWN_NATIVE
const markdown = ref<InstanceType<typeof ElMarkdownEditor>>()
const titleInput = ref<HTMLInputElement>()
const outlineRail = ref<InstanceType<typeof ArticleOutlineRail>>()
const splitOutlineSlot = ref<HTMLElement>()
// The clipboard confirmation is teleported outside its editor and has no public closing hook.
const comparisonCommands = defaultMarkdownEditorCommands.filter(command => command.key !== 'paste-as-markdown')
const titleId = computed(() => props.focus ? 'article-title' : `article-title-${props.pane.tab.sessionId}`)
const bodyId = computed(() => props.focus ? 'article-body' : `article-body-${props.pane.tab.sessionId}`)
const groupName = computed(() => props.pane.tab.group === 'main' ? t('author.workspaceSourcePane.primary.article.group') : t('author.workspaceSourcePane.secondary.article.group'))
const identity = computed(() => ({ id: `blog-editor-${props.pane.tab.sessionId}`, epoch: props.pane.tab.sessionId }))
const encoder = new TextEncoder()
const titleLength = computed(() => encoder.encode(props.pane.draft.title.trim()).length)
const crlf = ref(false)
watch(() => props.pane.draft.body, body => {
  // Leaving all line breaks out of a source edit keeps the established style for undo and new input.
  if (/[\r\n]/u.test(body)) crlf.value = hasUniformCrlf(body)
}, { immediate: true, flush: 'sync' })
const editorSource = computed(() => crlf.value ? normalizeCrlf(props.pane.draft.body) : props.pane.draft.body)

type OutlineModel = ReturnType<typeof createMarkdownOutlineModel>
const outlineVisible = ref(false)
const outlineState = ref<'loading' | 'ready' | 'unavailable'>('loading')
const outlineMode = ref<MarkdownEditorMode>('source')
const foreground = computed(() => props.focus && !props.concealed && !props.blocked)
const outlineDisabled = computed(() => editorSource.value.includes('\r') ||
  (outlineMode.value !== 'source' && outlineMode.value !== 'live'))
const editorDocument = shallowRef({ source: editorSource.value, revision: 0 })
let nextEdits: { value: string; edits: readonly BodyEdit[] } | undefined
const editorSelection = shallowRef<MarkdownEditorSelectionEvent['selection']>({
  start: editorSource.value.length, end: editorSource.value.length, direction: 'none',
})
const outlineDocument = computed(() => editorDocument.value.source === editorSource.value ? editorDocument.value : undefined)
const outlineSnapshot = shallowRef<{ model: OutlineModel; articleId: number; document: typeof editorDocument.value }>()
let previousOutline: OutlineModel['projection'] | undefined
const outlineArticle = computed(() => props.pane.draft.id)

watch(() => props.split, () => { outlineMode.value = 'source' })
watch(outlineArticle, () => { previousOutline = undefined }, { flush: 'sync' })
watch([outlineVisible, outlineDisabled, outlineArticle, outlineDocument, foreground], ([visible, disabled, articleId, source, foreground], _, cleanup) => {
  if (visible && !disabled && outlineSnapshot.value?.document === source && outlineSnapshot.value?.articleId === articleId) return
  outlineSnapshot.value = undefined
  outlineState.value = 'loading'
  if (!visible || disabled) previousOutline = undefined
  if (!visible || disabled || !foreground || !source) return
  if (source.source.length > 200_000) {
    outlineState.value = 'unavailable'
    return
  }
  const frame = requestAnimationFrame(() => {
    try {
      const model = createMarkdownOutlineModel(source.source, identity.value, previousOutline)
      previousOutline = model.projection
      outlineSnapshot.value = { model, articleId, document: source }
      outlineState.value = 'ready'
    } catch {
      previousOutline = undefined
      outlineState.value = 'unavailable'
    }
  })
  cleanup(() => cancelAnimationFrame(frame))
}, { flush: 'sync' })

const outlineActive = computed(() => {
  const snapshot = outlineSnapshot.value
  if (!snapshot) return null
  const selection = editorSelection.value
  return resolveMarkdownOutlineActive({
    items: snapshot.model.items, documentId: identity.value.id, documentEpoch: identity.value.epoch,
    revision: snapshot.document.revision, caret: selection.end, selection,
  }).headingId
})

function editorTransaction(event: MarkdownEditorTransactionEvent) {
  if (!event.accepted || event.documentIdentity.id !== identity.value.id || event.documentIdentity.epoch !== identity.value.epoch) return
  const prior = editorDocument.value
  nextEdits = undefined
  if (props.focus && !props.blocked && !props.concealed && prior.revision === event.beforeRevision &&
    prior.source === editorSource.value && (outlineMode.value === 'source' || outlineMode.value === 'live')) {
    // The public editor emits the accepted transaction before its model-value update.
    try {
      const edits = captureBodyEdits(props.pane.draft.body, prior.source, crlf.value, event)
      if (edits) nextEdits = { value: event.value, edits }
    } catch {
      // A missing or unsupported coordinate map leaves the ordinary save available.
    }
  }
  if (editorDocument.value.source !== event.value || editorDocument.value.revision !== event.revision)
    editorDocument.value = { source: event.value, revision: event.revision }
  editorSelection.value = event.selection
}

function editorSelectionChanged(event: MarkdownEditorSelectionEvent) {
  if (event.revision === editorDocument.value.revision) editorSelection.value = event.selection
}

function revealOutline(heading: MarkdownEditorOutlineItem): boolean {
  const snapshot = outlineSnapshot.value
  if (!foreground.value || outlineDisabled.value || !snapshot || snapshot.articleId !== outlineArticle.value || snapshot.document !== outlineDocument.value ||
    !snapshot.model.items.includes(heading)) return false
  const { start, end } = heading.sourceRange
  const status = markdown.value?.revealSourceRange({ start, end }, {
    expected: { documentIdentity: identity.value, revision: snapshot.document.revision }, mode: outlineMode.value,
  })
  if (status !== 'success') return false
  editorSelection.value = { start, end: start, direction: 'none' }
  return true
}

watch([() => props.sourceTarget, () => props.focus, () => props.blocked, () => props.concealed], async ([target, focused, blocked, concealed], _, cleanup) => {
  if (!target || !focused || blocked || concealed) return
  let mounted = true
  cleanup(() => { mounted = false })
  const ownsTarget = () => mounted && props.sourceTarget === target && props.focus && !props.blocked && !props.concealed &&
    props.pane.tab.sessionId === target.sessionId
  await nextTick()
  if (!ownsTarget()) return
  if (target.kind === 'search') {
    let success = false
    try { success = await revealSearch(target, ownsTarget) } catch { /* The current editor could not verify or reveal the source. */ }
    if (ownsTarget()) emit('sourceRevealed', target, success)
    return
  }
  const body = props.pane.draft.body
  const textarea = document.getElementById(bodyId.value)
  const { offset } = target
  const range = target.current() && props.pane.draft.revision === target.revision && body[offset] === '^' &&
    textarea instanceof HTMLTextAreaElement && textarea.value === editorSource.value
    ? textareaSourceRange(body, textarea.value, { start: offset, end: offset }) : undefined
  const success = !!range && markdown.value?.revealSourceRange(range, { mode: 'source', reducedMotion: true }) === 'success'
  if (success && range) editorSelection.value = { start: range.start, end: range.start, direction: 'none' }
  emit('sourceRevealed', target, success)
}, { immediate: true, flush: 'post' })

function visibleInput(control: HTMLInputElement | HTMLTextAreaElement): boolean {
  return control.isConnected && !control.disabled && !control.readOnly && !control.closest('[inert]') &&
    control.getClientRects().length !== 0
}

async function revealSearch(seek: Extract<EditorSourceSeek, { kind: 'search' }>, ownsTarget: () => boolean): Promise<boolean> {
  const { target } = seek
  const { field, sourceStart: start, sourceEnd: end } = target
  if (field === 'summary') return false
  const sourceField = field === 'heading' ? 'body' : field
  const source = props.pane.draft[sourceField]
  const editor = editorDocument.value
  const mode = outlineMode.value
  const previouslyFocused = document.activeElement
  const current = () => ownsTarget() && seek.current() && props.pane.tab.risk === 'clean' &&
    props.pane.draft.id === target.articleId && props.pane.draft.revision === target.revision && props.pane.draft[sourceField] === source &&
    (field === 'title' || editorDocument.value === editor && editorSource.value === editor.source && outlineMode.value === mode)
  if (!current() || !await verifySourceMatch(source, target) || !current() || document.activeElement !== previouslyFocused) return false

  if (field === 'title') {
    const input = titleInput.value
    if (!(input instanceof HTMLInputElement) || !visibleInput(input) || input.value !== source) return false
    input.focus()
    if (!current() || document.activeElement !== input || input.value !== source) return false
    input.setSelectionRange(start, end)
    return input.selectionStart === start && input.selectionEnd === end
  }

  const textarea = document.getElementById(bodyId.value)
  if ((mode !== 'source' && mode !== 'live') || !(textarea instanceof HTMLTextAreaElement) ||
      !visibleInput(textarea) || textarea.value !== editor.source) return false
  const range = textareaSourceRange(source, textarea.value, { start, end })
  if (!range || markdown.value?.revealSourceRange(range, {
    expected: { documentIdentity: identity.value, revision: editor.revision }, mode, reducedMotion: true,
  }) !== 'success') return false

  await nextTick()
  if (!current() || !visibleInput(textarea) || textarea.value !== editor.source || document.activeElement !== textarea ||
      textarea.selectionStart !== range.start || textarea.selectionEnd !== range.start) return false
  editorSelection.value = { start: range.start, end: range.start, direction: 'none' }
  return true
}

function edit(field: 'title' | 'body', value: string) {
  const edits = field === 'body' && nextEdits?.value === value ? nextEdits.edits : undefined
  if (field === 'body') nextEdits = undefined
  if (props.focus && !props.blocked) emit('edit', field, field === 'body' && crlf.value ? restoreCrlf(value) : value, edits)
}

function onOutlineVisibility(open: boolean) {
  outlineVisible.value = open
  emit('outlineVisibility', open)
}

defineExpose({
  openOutline: () => outlineRail.value?.open(),
  closeOutline: (restoreFocus = true) => outlineRail.value?.close(restoreFocus),
  toggleOutline: () => outlineRail.value?.toggle(),
  outlineDisabled,
  outlineVisible,
  hasNativeMarkdown: Boolean(nativeMarkdown),
})
</script>

<template>
  <section :id="`workspace-source-${pane.tab.sessionId}`" class="workspace-source" tabindex="-1" :aria-label="groupName"
    :class="{ 'workspace-source--secondary': pane.tab.group === 'secondary', 'workspace-source--split': split }"
    v-bind="{ hidden: concealed, inert: concealed }"
    @compositionstart.capture="emit('compose', true)" @compositionend="emit('compose', false)">
    <header v-if="split" class="workspace-source__heading">
      <h2>{{ groupName }}</h2>
      <div class="workspace-source__heading-actions">
        <span ref="splitOutlineSlot" class="workspace-source__outline-slot" />
        <ElButton v-if="!focus" text size="small" native-type="button" :disabled="!canSwitch" @click="emit('activate')">{{ t('author.workspaceSourcePane.edit.in.this.group') }}</ElButton>
      </div>
    </header>
    <div v-if="$slots.before" class="workspace-source__notices">
      <slot name="before" />
    </div>
    <div class="workspace-source__header">
      <label class="visually-hidden" :for="titleId">{{ t('author.authorTextSearch.title') }}</label>
      <input :id="titleId" ref="titleInput" class="workspace-source__title" type="text" :value="pane.draft.title"
        :placeholder="t('author.workspaceSourcePane.write.the.article.title')" :readonly="!focus" :disabled="focus && blocked"
        @input="edit('title', ($event.target as HTMLInputElement).value)" />
      <div class="workspace-source__meta">
        <div class="workspace-source__meta-left">
          <span class="workspace-source__bytes">{{ t('author.workspaceSourcePane.bytes', { p0: String(titleLength), p1: String(WireLimits.TitleBytes) }) }}</span>
          <span v-if="focus && (pane.tab.articleId === 0 || pane.tab.risk === 'dirty' || pane.tab.risk === 'conflict')" class="workspace-source__hint">{{ t('author.workspaceSourcePane.save.the.draft.before.publishing') }}</span>
        </div>
        <div class="workspace-source__meta-right">
          <label class="visually-hidden" :for="bodyId">{{ t('author.authorTextSearch.body') }}</label>
          <ArticleOutlineRail v-if="nativeMarkdown" ref="outlineRail" :foreground="foreground"
            :headings="outlineSnapshot?.model.items ?? []" :active="outlineActive" :state="outlineState" :disabled="outlineDisabled"
            :reveal="revealOutline" :launcher-target="split ? splitOutlineSlot : outlineLauncherTarget"
            :dock-target="outlineDockTarget" :fallback-opener="outlineFallbackOpener" @visibility="onOutlineVisibility" />
          <ElButton v-if="nativeMarkdown && focus && !concealed" text size="small" native-type="button" :disabled="blocked"
            @click="foreground && markdown?.openSearch()">{{ t('author.workspaceSourcePane.find.in.body') }}</ElButton>
        </div>
      </div>
    </div>
    <div v-if="$slots.import" class="workspace-source__import"><slot name="import" /></div>
    <div class="workspace-source__body">
      <ElMarkdownEditor v-if="nativeMarkdown" ref="markdown" class="workspace-source__markdown" :textarea-id="bodyId"
        :locale-text="{ textarea: { source: t('author.authorTextSearch.body'), live: t('author.authorTextSearch.body') } }"
        :model-value="editorSource" @update:model-value="edit('body', $event)" :placeholder="t('author.workspaceSourcePane.start.writing.here')"
        @transaction="editorTransaction" @selection-change="editorSelectionChanged" @mode-change="outlineMode = $event"
        :document-identity="identity" :readonly="!focus" :disabled="focus && blocked" :show-actions="false"
        :chrome="split ? 'framed' : 'embedded'" :editor-profile="split ? 'markdown' : 'prose'"
        :mode="split ? 'source' : undefined" :commands="split ? comparisonCommands : undefined" :show-mode-switcher="!split" />
      <template v-else>
        <ElAlert :title="t('author.workspaceSourcePane.rich.editing.unavailable.edit.the.original.markdown.below')" type="info" :closable="false" />
        <ElInput :id="bodyId" :model-value="editorSource" @update:model-value="edit('body', $event)" type="textarea"
          :autosize="{ minRows: 14 }" :placeholder="t('author.workspaceSourcePane.start.writing.here')" :readonly="!focus" :disabled="focus && blocked" />
      </template>
    </div>
    <div v-if="$slots.after" class="workspace-source__after"><slot name="after" /></div>
  </section>
</template>

<style scoped>
.workspace-source { display: flex; flex-direction: column; gap: var(--fsus-space-3); inline-size: min(50rem, 100%); min-inline-size: 0; min-block-size: 100%; margin-inline: auto; padding-block: var(--fsus-space-4) var(--fsus-space-5); }
.workspace-source--split { inline-size: 100%; margin-inline: 0; padding-block: var(--fsus-space-3); }
.workspace-source[hidden], .workspace-source__notices:empty, .workspace-source__import:empty, .workspace-source__after:empty { display: none; }
.workspace-source__heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--fsus-space-2); padding-block-end: var(--fsus-space-2); border-block-end: 1px solid var(--fsus-border); }
.workspace-source__heading h2 { margin: 0; font-size: var(--fsus-typography-heading-sm-size); font-weight: 600; }
.workspace-source__heading-actions { display: inline-flex; align-items: center; gap: var(--fsus-space-1); }
.workspace-source__outline-slot { display: contents; }
.workspace-source__notices, .workspace-source__after, .workspace-source__header { display: grid; gap: var(--fsus-space-2); }
.workspace-source__title { inline-size: 100%; min-inline-size: 0; padding: var(--fsus-space-1) 0 var(--fsus-space-3); border: 0; border-block-end: 1px solid var(--fsus-border); border-radius: 0; background: transparent; color: var(--fsus-ink); font-family: inherit; font-size: clamp(1.375rem, 2.4vw, 1.875rem); font-weight: 700; line-height: 1.3; letter-spacing: -0.015em; }
.workspace-source__title::placeholder { color: var(--fsus-color-text-muted); font-weight: 500; }
.workspace-source__title:focus-visible { outline: none; border-block-end-color: var(--fsus-color-action-primary); box-shadow: 0 1px 0 0 var(--fsus-color-action-primary); }
.workspace-source__title:disabled { opacity: 0.65; }
.workspace-source__meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--fsus-space-2); min-block-size: 2rem; }
.workspace-source__meta-left, .workspace-source__meta-right { position: relative; display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--fsus-space-2); }
.workspace-source__bytes, .workspace-source__hint { color: var(--fsus-color-text-muted); font-size: .8125rem; line-height: 1.4; }
.workspace-source__bytes { font-variant-numeric: tabular-nums; }
.workspace-source__body { display: flex; flex: 1 1 auto; flex-direction: column; min-inline-size: 0; min-block-size: 0; }
.workspace-source__markdown { flex: 1 1 auto; }
@media (max-width: 1023px) {
  .workspace-source { gap: var(--fsus-space-2); padding-block: var(--fsus-space-3) var(--fsus-space-4); }
  .workspace-source__title { font-size: clamp(1.1875rem, 5vw, 1.375rem); padding-block-end: var(--fsus-space-2); }
}
@media (forced-colors: active) { .workspace-source__title:focus-visible { outline: 2px solid Highlight; box-shadow: none; } }
</style>
