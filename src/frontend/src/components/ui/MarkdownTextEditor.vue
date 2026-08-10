<template>
  <div
    ref="rootRef"
    class="markdown-text-editor"
    @click.capture="rememberTextareaSelectionFromEvent"
    @focusin.capture="rememberTextareaSelectionFromEvent"
    @keyup.capture="rememberTextareaSelectionFromEvent"
    @select.capture="rememberTextareaSelectionFromEvent"
    @keydown.capture="handleKeydown"
    @paste.capture="handlePaste"
  >
    <ElMarkdownEditor
      ref="editorRef"
      v-model="localValue"
      class="markdown-text-editor__fsusui"
      :action-overflow-keys="actionOverflowKeys"
      :commands="fsusUiCommands"
      command-overflow-label="格式工具"
      :default-mode="fsusUiMode"
      :disabled="editorDisabled"
      editor-profile="prose"
      image-action-label="上传图片"
      interaction-profile="auto"
      mobile-layout="auto"
      :mode="fsusUiMode"
      :placeholder="placeholder"
      :primary-command-keys="primaryCommandKeys"
      :show-actions="showImageAction || showSaveAction"
      :show-image-action="showImageAction"
      :show-mode-switcher="false"
      :show-save-action="showSaveAction"
      :show-submit-action="false"
      :textarea-id="textareaId"
      :textarea-name="textareaName"
      :writing-placeholder="writingPlaceholder"
      @save="emitSave"
      @submit="emitSubmit"
      @upload-image="requestImageUpload"
    >
      <template #status>
        <div class="markdown-text-editor__status">
          <div class="markdown-text-editor__status-group markdown-text-editor__status-group--primary">
            <span class="markdown-text-editor__status-item">
              <span class="markdown-text-editor__status-label">模式</span>
              <span class="markdown-text-editor__status-value">{{ currentModeLabel }}</span>
            </span>
            <span class="markdown-text-editor__status-separator" aria-hidden="true"></span>
            <span class="markdown-text-editor__status-item">
              <span class="markdown-text-editor__status-label">位置</span>
              <span class="markdown-text-editor__status-value">第 {{ cursorLine }} 行，第 {{ cursorColumn }} 列</span>
            </span>
          </div>
          <div class="markdown-text-editor__status-group markdown-text-editor__status-group--metrics" aria-label="正文统计">
            <span>{{ lineCount }} 行</span>
            <span>{{ charCount }} 字</span>
            <span>{{ wordCount }} 词</span>
            <span>{{ readingTimeText }}</span>
          </div>
          <div class="markdown-text-editor__status-group markdown-text-editor__status-group--secondary">
            <span>{{ keyboardHint }}</span>
            <span v-if="editorStateText" class="markdown-text-editor__status-state">{{ editorStateText }}</span>
          </div>
        </div>
      </template>
    </ElMarkdownEditor>

    <input
      ref="imageInputRef"
      type="file"
      accept="image/*"
      class="hidden"
      aria-hidden="true"
      tabindex="-1"
      @change="handleImagePick"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMarkdownEditor, type MarkdownEditorCommand as FsusUiMarkdownEditorCommand, type MarkdownEditorMode as FsusUiMarkdownEditorMode, type MarkdownEditorSelection as FsusUiMarkdownEditorSelection } from '@ozwasyd/element-plus'
import type {
  MarkdownEditorCommand,
  MarkdownEditorCommandKey,
  MarkdownEditorMode
} from '@/ui-contracts/markdownEditor'
import {
  executeMarkdownEditorCommand,
  markdownEditorCommands
} from '@/components/ui/markdown-editor/commands'
import { createSnapshot, replaceSelection, type SelectionResult, type SelectionSnapshot } from '@/components/ui/markdown-editor/selection'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { estimateReading } from '@/utils/readingEstimate'

type FsusUiMarkdownEditorExpose = Readonly<{
  insertMarkdownAtCursor?: (markdown: string) => boolean
}>

type BlogCommandKey = Exclude<MarkdownEditorCommandKey, 'undo' | 'redo' | 'image' | 'save'>
type WordSegment = { isWordLike?: boolean }
type WordSegmenter = { segment: (input: string) => Iterable<WordSegment> }
type WordSegmenterConstructor = new (locale: string, options: { granularity: 'word' }) => WordSegmenter

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  textareaId?: string
  textareaName?: string
  mode?: MarkdownEditorMode
  toolbarsExclude?: string[]
  saving?: boolean
  loading?: boolean
}>(), {
  placeholder: '',
  textareaId: undefined,
  textareaName: 'markdownContent',
  mode: 'write',
  toolbarsExclude: () => [],
  saving: false,
  loading: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'on-save'): void
  (e: 'on-draft-save'): void
  (e: 'on-submit'): void
  (e: 'on-upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void
}>()

const rootRef = ref<HTMLElement | null>(null)
const editorRef = ref<FsusUiMarkdownEditorExpose | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)
const isUploading = ref(false)
const uploadError = ref('')
const lastSelection = ref<SelectionSnapshot | null>(null)
const cursorState = ref({ line: 1, column: 1 })

const SegmenterCtor = (Intl as typeof Intl & { Segmenter?: WordSegmenterConstructor }).Segmenter
const zhWordSegmenter = SegmenterCtor ? new SegmenterCtor('zh', { granularity: 'word' }) : null
const fsusCommandKeys = new Set<BlogCommandKey>([
  'h1',
  'h2',
  'h3',
  'bold',
  'italic',
  'quote',
  'ul',
  'ol',
  'task',
  'link',
  'code',
  'block',
  'latex',
  'mermaid',
  'table',
  'hr'
])
const narrowCommandLayout = useMediaQuery('(max-width: 639px)', false)
const primaryCommandKeys = computed<readonly BlogCommandKey[]>(() => (
  narrowCommandLayout.value
    ? ['h1', 'h2', 'bold', 'italic']
    : ['h1', 'h2', 'bold', 'italic', 'quote', 'link']
))
const actionOverflowKeys = ['image'] as const

const localValue = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const editorDisabled = computed(() => props.saving || props.loading)
const excludedToolbarKeys = computed(() => new Set(props.toolbarsExclude))
const showImageAction = computed(() => !excludedToolbarKeys.value.has('image'))
const showSaveAction = computed(() => !excludedToolbarKeys.value.has('save'))
const fsusUiMode = computed<FsusUiMarkdownEditorMode>(() => props.mode === 'preview' ? 'preview' : 'write')
const writingPlaceholder = computed(() => props.placeholder || '从这里开始写正文。')
const lineCount = computed(() => (localValue.value ? localValue.value.split('\n').length : 1))
const charCount = computed(() => localValue.value.length)
const readingEstimate = computed(() => estimateReading(localValue.value))
const wordCount = computed(() => {
  const value = localValue.value.trim()
  if (value && zhWordSegmenter) {
    return Array.from(zhWordSegmenter.segment(value)).filter((segment) => segment.isWordLike).length
  }

  const matches = value.match(/\S+/g)
  return matches ? matches.length : 0
})
const readingMinutes = computed(() => readingEstimate.value.minutes)
const readingTimeText = computed(() =>
  readingEstimate.value.effectiveChars === 0 ? '少于 1 分钟' : `约 ${readingMinutes.value} 分钟`
)
const cursorLine = computed(() => cursorState.value.line)
const cursorColumn = computed(() => cursorState.value.column)
const currentModeLabel = computed(() => {
  if (props.mode === 'split') return '分屏'
  return props.mode === 'preview' ? '预览' : '编写'
})
const keyboardHint = computed(() => 'Tab 缩进 / Shift+Tab 反缩进 / Esc 离开')
const editorStateText = computed(() => {
  if (props.saving) {
    return '正在写入'
  }

  if (props.loading) {
    return '初始化中'
  }

  if (isUploading.value) {
    return '图片上传中'
  }

  if (uploadError.value) {
    return uploadError.value
  }

  return null
})
const fsusUiCommands = computed<readonly FsusUiMarkdownEditorCommand[]>(() =>
  markdownEditorCommands
    .filter((command) => fsusCommandKeys.has(command.key as BlogCommandKey))
    .filter((command) => !excludedToolbarKeys.value.has(command.key))
    .map(toFsusUiCommand))

function toFsusUiCommand(command: MarkdownEditorCommand): FsusUiMarkdownEditorCommand {
  return {
    key: command.key,
    label: command.label,
    shortcut: normalizeShortcut(command.shortcut),
    title: command.ariaLabel || command.label,
    apply: (value, selection) => applyBlogCommand(command.key as BlogCommandKey, value, selection)
  }
}

function normalizeShortcut(shortcut?: string): string | undefined {
  if (!shortcut) {
    return undefined
  }

  return shortcut.replace(/^Ctrl\+/u, 'Mod+')
}

function applyBlogCommand(
  key: BlogCommandKey,
  value: string,
  selection: FsusUiMarkdownEditorSelection
): { nextSelection?: FsusUiMarkdownEditorSelection; value: string } {
  const result = executeMarkdownEditorCommand(key, {
    snapshot: createSnapshot(value, selection.start, selection.end)
  })

  return {
    nextSelection: {
      start: result.start,
      end: result.end
    },
    value: result.value
  }
}

function cursorFromIndex(value: string, index: number): { line: number; column: number } {
  const safeIndex = Math.max(0, Math.min(index, value.length))
  const before = value.slice(0, safeIndex)
  const lines = before.split('\n')
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  }
}

function textareaFromEvent(event: Event): HTMLTextAreaElement | null {
  const target = event.target
  return target instanceof HTMLTextAreaElement ? target : null
}

function snapshotFromTextarea(textarea: HTMLTextAreaElement): SelectionSnapshot {
  return createSnapshot(localValue.value, textarea.selectionStart, textarea.selectionEnd)
}

function rememberTextareaSelection(textarea: HTMLTextAreaElement): void {
  const snapshot = snapshotFromTextarea(textarea)
  lastSelection.value = snapshot
  cursorState.value = cursorFromIndex(snapshot.value, snapshot.start)
}

function rememberTextareaSelectionFromEvent(event: Event): void {
  const textarea = textareaFromEvent(event)
  if (textarea) {
    rememberTextareaSelection(textarea)
  }
}

async function applyResult(result: SelectionResult): Promise<void> {
  localValue.value = result.value
  await nextTick()
  const textarea = rootRef.value?.querySelector('textarea')
  textarea?.focus()
  textarea?.setSelectionRange(result.start, result.end)
  if (textarea) {
    rememberTextareaSelection(textarea)
  }
}

async function insertMarkdownFromSnapshot(markdown: string, snapshot: SelectionSnapshot): Promise<void> {
  await applyResult(replaceSelection(snapshot, markdown))
}

function insertMarkdownAtCursor(markdown: string): boolean {
  return editorRef.value?.insertMarkdownAtCursor?.(markdown) === true
}

function emitSave(): void {
  emit('on-draft-save')
  emit('on-save')
}

function emitSubmit(): void {
  emit('on-submit')
}

function requestImageUpload(): void {
  imageInputRef.value?.click()
}

async function handleImagePick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null
  const files = Array.from(input?.files || [])
  if (!files.length) {
    return
  }

  const textarea = rootRef.value?.querySelector('textarea')
  const snapshot = textarea ? snapshotFromTextarea(textarea) : lastSelection.value
  if (!snapshot) {
    return
  }

  await uploadImages(files, snapshot)

  if (input) {
    input.value = ''
  }
}

function handlePaste(event: ClipboardEvent): void {
  const textarea = textareaFromEvent(event)
  if (!textarea) {
    return
  }

  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))
  if (files.length) {
    event.preventDefault()
    void uploadImages(files, snapshotFromTextarea(textarea))
    return
  }

  const text = event.clipboardData?.getData('text/plain')
  if (!text) {
    return
  }

  const url = text.trim()
  if (/^https?:\/\//.test(url)) {
    uploadError.value = ''
  }
}

function handleKeydown(event: KeyboardEvent): void {
  const textarea = textareaFromEvent(event)
  if (!textarea) {
    return
  }

  if (event.key === 'Escape') {
    focusNextControl(textarea)
  }
}

function focusNextControl(textarea: HTMLTextAreaElement): void {
  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',')
  const focusable = Array.from(document.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => !element.hasAttribute('aria-hidden') && element.offsetParent !== null)
  const currentIndex = focusable.indexOf(textarea)
  focusable[currentIndex + 1]?.focus()
}

function normalizeImageAlt(fileName: string): string {
  const baseName = fileName
    .replace(/\.[^.]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
  return baseName || '图片'
}

function createUploadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function replaceUploadPlaceholders(placeholders: readonly { token: string }[], replacements: readonly string[]): void {
  let nextValue = localValue.value
  placeholders.forEach((placeholder, index) => {
    nextValue = nextValue.replace(placeholder.token, replacements[index] || '')
  })
  localValue.value = nextValue
}

async function uploadImages(files: File[], snapshot: SelectionSnapshot): Promise<void> {
  isUploading.value = true
  uploadError.value = ''
  const placeholders = files.map((file) => {
    const alt = normalizeImageAlt(file.name)
    const id = createUploadId()
    return {
      id,
      alt,
      token: `![uploading: ${alt}](fsus-upload-placeholder://${id})`
    }
  })

  await insertMarkdownFromSnapshot(placeholders.map((placeholder) => placeholder.token).join('\n'), snapshot)

  emit(
    'on-upload-img',
    files,
    async (urls) => {
      try {
        const markdown = urls.map((url, index) => `![${placeholders[index]?.alt || '图片'}](${url})`)
        replaceUploadPlaceholders(placeholders, markdown)
        uploadError.value = ''
      } finally {
        isUploading.value = false
      }
    },
    (message) => {
      const failed = placeholders.map((placeholder) =>
        `![上传失败: ${placeholder.alt}](fsus-upload-placeholder://failed-${placeholder.id})`)
      replaceUploadPlaceholders(placeholders, failed)
      uploadError.value = `${message}，可重新粘贴或点击图片按钮重试`
      isUploading.value = false
    }
  )
}

watch(() => props.modelValue, () => {
  if (!isUploading.value) {
    uploadError.value = ''
  }
})

defineExpose({
  insertMarkdownAtCursor
})
</script>

<style scoped>
.markdown-text-editor {
  width: 100%;
  height: 100%;
  min-width: 0;
}

.markdown-text-editor__fsusui {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.markdown-text-editor__status {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.4rem 1rem;
  align-items: center;
}

.markdown-text-editor__status-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
}

.markdown-text-editor__status-group--metrics {
  grid-column: 1;
  grid-row: 2;
  justify-content: flex-start;
  color: var(--fsusblog-text-muted);
}

.markdown-text-editor__status-group--metrics span {
  display: inline-flex;
  min-height: 1.5rem;
  align-items: center;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control-small);
  padding: 0 0.45rem;
  background: var(--fsusblog-page-bg);
  white-space: nowrap;
}

.markdown-text-editor__status-group--secondary {
  grid-column: 2;
  grid-row: 1 / span 2;
  flex-direction: column;
  align-items: flex-end;
  justify-content: flex-end;
  gap: 0.25rem;
  color: var(--fsusblog-text-tertiary);
}

.markdown-text-editor__status-item {
  display: inline-flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.35rem;
  white-space: nowrap;
}

.markdown-text-editor__status-label {
  color: var(--fsusblog-text-tertiary);
}

.markdown-text-editor__status-separator {
  width: 1px;
  height: 0.875rem;
  background: var(--fsusblog-panel-border);
}

.markdown-text-editor__status-value,
.markdown-text-editor__status-state {
  color: var(--fsusblog-text-muted);
  font-weight: 700;
}

.markdown-text-editor__status-state {
  display: inline-flex;
  min-height: 1.5rem;
  align-items: center;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control-small);
  padding: 0 0.5rem;
  background: var(--fsusblog-page-bg);
  white-space: nowrap;
}

@media (max-width: 620px) {
  .markdown-text-editor__status {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }

  .markdown-text-editor__status-group {
    align-items: flex-start;
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .markdown-text-editor__status-group--primary {
    grid-column: 1;
    grid-row: 1;
  }

  .markdown-text-editor__status-group--metrics {
    grid-column: 2;
    grid-row: 1;
    align-items: flex-start;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .markdown-text-editor__status-group--secondary {
    grid-column: 1 / -1;
    grid-row: 2;
    align-items: flex-start;
    justify-content: flex-start;
    flex-wrap: wrap;
    flex-direction: row;
  }
}

</style>
