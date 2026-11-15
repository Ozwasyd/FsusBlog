<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from 'vue'
import { ElAlert, ElButton, ElInput } from '@ozwasyd/element-plus'
import { draftSummary, type DraftSummaryEdit } from '../../../Contracts/article-summary-client'
import type { ArticleSummary } from '../../../Contracts/article-summary'
import { ApiError } from '../../../Contracts/client'
import { WireLimits } from '../../../Contracts/wire.generated'
import type { EditorSourceSeek } from './canvasEditorHandoff'
import { textareaSourceRange, verifySourceMatch } from './sourceCoordinates'

type SummarySeek = Extract<EditorSourceSeek, { kind: 'search' }>

const props = defineProps<{
  articleId: number
  revision: bigint
  credential?: string
  canChange: boolean
  saving: boolean
  sourceTarget?: SummarySeek
  inspectorReady: boolean
}>()
const emit = defineEmits<{
  change: [dirty: boolean]; save: [edit: DraftSummaryEdit]
  sourceRevealed: [target: SummarySeek, success: boolean]
}>()
const descriptionId = useId()
const opened = ref(false)
const expanded = ref(false)
const disclosure = ref<HTMLDetailsElement>()
const retry = ref(0)
const loaded = shallowRef<ArticleSummary>()
const text = ref('')
const input = ref<InstanceType<typeof ElInput>>()
const loading = ref(false)
const error = ref('')
const dirty = computed(() => !!loaded.value && text.value !== loaded.value.text)
const valid = computed(() => text.value.length <= WireLimits.ArticleSummaryEditChars &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text.value))

watch(dirty, value => emit('change', value), { flush: 'sync' })
watch(() => [props.articleId, props.revision, props.credential, opened.value, retry.value] as const,
  async ([articleId, revision, credential, requested], _, cleanup) => {
    const read = new AbortController()
    cleanup(() => read.abort())
    loaded.value = undefined
    text.value = ''
    loading.value = false
    error.value = ''
    if (!requested || !credential) return
    loading.value = true
    try {
      const summary = await draftSummary(articleId, revision, credential, read.signal)
      if (read.signal.aborted) return
      text.value = summary.text
      loaded.value = summary
    } catch (failure) {
      if (read.signal.aborted) return
      error.value = failure instanceof ApiError && failure.status === 409
        ? 'This summary no longer matches the open draft revision. Reload the draft to continue.'
        : 'Could not load the article summary.'
    } finally {
      if (!read.signal.aborted) loading.value = false
    }
  }, { flush: 'sync' })

watch([() => props.sourceTarget, () => props.canChange, () => props.inspectorReady], ([seek, canChange, inspectorReady]) => {
  if (!seek) return
  if (!canChange || !inspectorReady) return
  if (seek.target.field !== 'summary' || !seek.current() || dirty.value) {
    emit('sourceRevealed', seek, false)
    return
  }
  expanded.value = true
  opened.value = true
}, { immediate: true, flush: 'post' })

watch([() => props.sourceTarget, () => props.inspectorReady, expanded, loading, loaded, error, input],
  async ([seek, inspectorReady, visible, working, summary, failure, control], _, cleanup) => {
    if (!seek || !inspectorReady || !visible || working) return
    if (failure) { emit('sourceRevealed', seek, false); return }
    const textarea = control?.textarea
    if (!summary || !(textarea instanceof HTMLTextAreaElement)) return
    let active = true
    cleanup(() => { active = false })
    const current = () => active && props.sourceTarget === seek && seek.current() && props.inspectorReady &&
      disclosure.value?.open === true && props.canChange && !dirty.value && loaded.value === summary && text.value === summary.text &&
      props.articleId === summary.id && props.revision === summary.revision && seek.target.field === 'summary' &&
      seek.target.articleId === summary.id && seek.target.revision === summary.revision && input.value?.textarea === textarea &&
      textarea.isConnected && !textarea.disabled && !textarea.readOnly && !textarea.closest('[inert]') && textarea.getClientRects().length > 0
    const previousFocus = document.activeElement
    let success = false
    try {
      const { sourceStart: start, sourceEnd: end } = seek.target
      if (current() && await verifySourceMatch(summary.text, seek.target) && current() && document.activeElement === previousFocus) {
        const range = textareaSourceRange(summary.text, textarea.value, { start, end }, 'native')
        if (range) {
          const value = textarea.value
          textarea.focus()
          if (current() && textarea.value === value && document.activeElement === textarea) {
            textarea.setSelectionRange(range.start, range.end)
            success = current() && document.activeElement === textarea && textarea.value === value &&
              textarea.selectionStart === range.start && textarea.selectionEnd === range.end
          }
        }
      }
    } catch {
      // Keep the saved summary open if the source could not be verified.
    } finally {
      if (active && props.sourceTarget === seek) emit('sourceRevealed', seek, success)
    }
  }, { flush: 'post' })

function toggle(event: Event) {
  expanded.value = (event.currentTarget as HTMLDetailsElement).open
  if (expanded.value) opened.value = true
  else if (props.sourceTarget) emit('sourceRevealed', props.sourceTarget, false)
}

function setText(value: string) {
  text.value = value
  input.value?.focus()
}

function save() {
  const { credential, articleId, revision } = props
  if (!loaded.value || !credential || !props.canChange || !dirty.value || !valid.value) return
  emit('save', { articleId, revision, credential, text: text.value })
}
</script>

<template>
  <details ref="disclosure" class="article-summary" :open="expanded" @toggle="toggle">
    <summary>Article summary</summary>
    <p v-if="loading" role="status">Loading summary…</p>
    <template v-else-if="error">
      <ElAlert :title="error" type="error" :closable="false" />
      <ElButton native-type="button" text @click="retry++">Retry summary</ElButton>
    </template>
    <div v-else-if="loaded" class="summary-fields">
      <p :id="descriptionId">Leave empty to use the generated summary.</p>
      <ElInput ref="input" v-model="text" type="textarea" label="Summary text" :disabled="!canChange"
        v-bind="{ maxlength: WireLimits.ArticleSummaryEditChars, 'aria-describedby': descriptionId }" />
      <p v-if="dirty && !valid" role="status">Use plain text up to {{ WireLimits.ArticleSummaryEditChars }} characters.</p>
      <p v-else-if="saving" role="status">Saving summary…</p>
      <div class="summary-actions">
        <ElButton native-type="button" :disabled="!canChange || !dirty || !valid" @click="save">Save summary</ElButton>
        <ElButton v-if="text" native-type="button" :disabled="!canChange" text @click="setText('')">Clear summary</ElButton>
        <ElButton v-if="dirty" native-type="button" :disabled="!canChange" text @click="setText(loaded.text)">Discard summary changes</ElButton>
      </div>
    </div>
  </details>
</template>

<style scoped>
summary { cursor: pointer; }
.summary-fields { display: grid; gap: var(--fsus-space-2); padding-block: var(--fsus-space-2); }
.summary-fields p { margin-block: 0; }
.summary-actions { display: flex; flex-wrap: wrap; gap: var(--fsus-space-2); }
.summary-actions :deep(.el-button + .el-button) { margin-inline-start: 0; }
</style>
