<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import {
  createMarkdownOutlineModel, defaultMarkdownEditorCommands, ElAlert, ElButton, ElInput, ElMarkdownEditor,
  resolveMarkdownOutlineActive, type MarkdownEditorMode, type MarkdownEditorOutlineItem,
  type MarkdownEditorSelectionEvent, type MarkdownEditorTransactionEvent,
} from '@ozwasyd/element-plus'
import type { Draft } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import ArticleOutlineRail from './ArticleOutlineRail.vue'
import type { EditorSourceSeek } from './canvasEditorHandoff'
import { hasUniformCrlf, normalizeCrlf, restoreCrlf, textareaSourceRange, verifySourceMatch } from './sourceCoordinates'
import type { WorkspaceSource } from './workspaceRegistry'

const props = defineProps<{
  pane: WorkspaceSource<Draft>; focus: boolean; blocked: boolean; split: boolean; canSwitch: boolean; concealed: boolean
  sourceTarget?: EditorSourceSeek
}>()
const emit = defineEmits<{
  edit: [field: 'title' | 'body', value: string]; activate: []; compose: [active: boolean]
  sourceRevealed: [target: EditorSourceSeek, success: boolean]
}>()
const nativeMarkdown = import.meta.env.FSUS_MARKDOWN_NATIVE
const markdown = ref<InstanceType<typeof ElMarkdownEditor>>()
const titleInput = ref<InstanceType<typeof ElInput>>()
// The clipboard confirmation is teleported outside its editor and has no public closing hook.
const comparisonCommands = defaultMarkdownEditorCommands.filter(command => command.key !== 'paste-as-markdown')
const titleId = computed(() => props.focus ? 'article-title' : `article-title-${props.pane.tab.sessionId}`)
const bodyId = computed(() => props.focus ? 'article-body' : `article-body-${props.pane.tab.sessionId}`)
const groupName = computed(() => props.pane.tab.group === 'main' ? 'Primary article group' : 'Secondary article group')
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
const outlineDisabled = computed(() => !props.focus || props.concealed || props.blocked || editorSource.value.includes('\r') ||
  (outlineMode.value !== 'source' && outlineMode.value !== 'live'))
const editorDocument = shallowRef({ source: editorSource.value, revision: 0 })
const editorSelection = shallowRef<MarkdownEditorSelectionEvent['selection']>({
  start: editorSource.value.length, end: editorSource.value.length, direction: 'none',
})
const outlineDocument = computed(() => editorDocument.value.source === editorSource.value ? editorDocument.value : undefined)
const outlineSnapshot = shallowRef<{ model: OutlineModel; articleId: number; document: typeof editorDocument.value }>()
let previousOutline: OutlineModel['projection'] | undefined
const outlineArticle = computed(() => props.pane.draft.id)

watch(() => props.split, () => { outlineMode.value = 'source' })
watch(outlineDisabled, disabled => { if (disabled) outlineVisible.value = false }, { flush: 'sync' })
watch(outlineArticle, () => { previousOutline = undefined }, { flush: 'sync' })
watch([outlineVisible, outlineDisabled, outlineArticle, outlineDocument], ([visible, disabled, articleId, source], _, cleanup) => {
  outlineSnapshot.value = undefined
  outlineState.value = 'loading'
  if (!visible || disabled) {
    previousOutline = undefined
    return
  }
  if (!source) return
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
  if (editorDocument.value.source !== event.value || editorDocument.value.revision !== event.revision)
    editorDocument.value = { source: event.value, revision: event.revision }
  editorSelection.value = event.selection
}

function editorSelectionChanged(event: MarkdownEditorSelectionEvent) {
  if (event.revision === editorDocument.value.revision) editorSelection.value = event.selection
}

function revealOutline(heading: MarkdownEditorOutlineItem): boolean {
  const snapshot = outlineSnapshot.value
  if (outlineDisabled.value || !snapshot || snapshot.articleId !== outlineArticle.value || snapshot.document !== outlineDocument.value ||
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
    const input = titleInput.value?.input
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
  if (props.focus && !props.blocked) emit('edit', field, field === 'body' && crlf.value ? restoreCrlf(value) : value)
}
</script>

<template>
  <section :id="`workspace-source-${pane.tab.sessionId}`" class="workspace-source" tabindex="-1" :aria-label="groupName"
    :class="{ 'workspace-source--secondary': pane.tab.group === 'secondary' }" v-bind="{ hidden: concealed, inert: concealed }"
    @compositionstart.capture="emit('compose', true)" @compositionend="emit('compose', false)">
    <header v-if="split" class="workspace-source__heading">
      <h2>{{ groupName }}</h2>
      <ElButton v-if="!focus" text native-type="button" :disabled="!canSwitch" @click="emit('activate')">Edit in this group</ElButton>
    </header>
    <slot name="before" />
    <label :for="titleId">Title</label>
    <ElInput ref="titleInput" :id="titleId" :model-value="pane.draft.title" @update:model-value="edit('title', $event)"
      placeholder="Write the article title" size="large" :readonly="!focus" :disabled="focus && blocked" />
    <p v-if="focus && (pane.tab.articleId === 0 || pane.tab.risk === 'dirty' || pane.tab.risk === 'conflict')" class="metadata">Save the draft before publishing.</p>
    <p class="metadata">{{ titleLength }} / {{ WireLimits.TitleBytes }} bytes</p>
    <div class="workspace-source__body-heading">
      <label :for="bodyId">Body</label>
      <ArticleOutlineRail v-if="nativeMarkdown && focus && !concealed"
        :headings="outlineSnapshot?.model.items ?? []" :active="outlineActive" :state="outlineState"
        :disabled="outlineDisabled" :reveal="revealOutline" @visibility="outlineVisible = $event" />
    </div>
    <ElMarkdownEditor v-if="nativeMarkdown" ref="markdown" :textarea-id="bodyId" :locale-text="{ textarea: { source: 'Body', live: 'Body' } }"
      :model-value="editorSource" @update:model-value="edit('body', $event)" placeholder="Start writing here."
      @transaction="editorTransaction" @selection-change="editorSelectionChanged" @mode-change="outlineMode = $event"
      :document-identity="identity" :readonly="!focus" :disabled="focus && blocked" :show-actions="false"
      :mode="split ? 'source' : undefined" :commands="split ? comparisonCommands : undefined" :show-mode-switcher="!split" />
    <template v-else>
      <ElAlert title="Rich editing unavailable. Edit the original Markdown below." type="info" :closable="false" />
      <ElInput :id="bodyId" :model-value="editorSource" @update:model-value="edit('body', $event)" type="textarea"
        :autosize="{ minRows: 14 }" placeholder="Start writing here." :readonly="!focus" :disabled="focus && blocked" />
    </template>
    <slot name="after" />
  </section>
</template>

<style scoped>
.workspace-source { display: grid; align-content: start; gap: .5rem; min-inline-size: 0; }
.workspace-source[hidden] { display: none; }
.workspace-source__heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .5rem; }
.workspace-source__heading h2 { margin: 0; font-size: var(--fsus-typography-heading-sm-size); }
.workspace-source__body-heading { display: flex; align-items: center; gap: var(--fsus-space-3); }
</style>
