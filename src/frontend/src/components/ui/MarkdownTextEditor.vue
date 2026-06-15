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
      :commands="fsusUiCommands"
      :default-mode="fsusUiMode"
      :disabled="editorDisabled"
      :mode="fsusUiMode"
      :placeholder="placeholder"
      :show-actions="showImageAction || showSaveAction"
      :show-image-action="showImageAction"
      :show-mode-switcher="false"
      :show-save-action="showSaveAction"
      :show-submit-action="false"
      :textarea-id="textareaId"
      :textarea-name="textareaName"
      @save="emitSave"
      @submit="emitSubmit"
      @upload-image="requestImageUpload"
    >
      <template #status>
        <span>模式 {{ currentModeLabel }}</span>
        <span>行 {{ lineCount }}</span>
        <span>字 {{ charCount }}</span>
        <span>词 {{ wordCount }}</span>
        <span>约 {{ readingMinutes }} 分钟</span>
        <span>Ln {{ cursorLine }}, Col {{ cursorColumn }}</span>
        <span>Tab 缩进，Shift+Tab 反缩进，Esc 离开编辑区</span>
        <span>{{ saveHint }}</span>
        <span v-if="loading">编辑器初始化中</span>
        <span v-else-if="saving">内容正在写入</span>
        <span v-else-if="isUploading">图片上传中，可继续编辑</span>
        <span v-else-if="uploadError">{{ uploadError }}</span>
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
  indentSelection,
  markdownEditorCommands,
  outdentSelection
} from '@/components/ui/markdown-editor/commands'
import { createSnapshot, replaceSelection, type SelectionResult, type SelectionSnapshot } from '@/components/ui/markdown-editor/selection'

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

const localValue = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const editorDisabled = computed(() => props.saving || props.loading)
const excludedToolbarKeys = computed(() => new Set(props.toolbarsExclude))
const showImageAction = computed(() => !excludedToolbarKeys.value.has('image'))
const showSaveAction = computed(() => !excludedToolbarKeys.value.has('save'))
const fsusUiMode = computed<FsusUiMarkdownEditorMode>(() => props.mode === 'preview' ? 'preview' : 'write')
const lineCount = computed(() => (localValue.value ? localValue.value.split('\n').length : 1))
const charCount = computed(() => localValue.value.length)
const wordCount = computed(() => {
  const value = localValue.value.trim()
  if (value && zhWordSegmenter) {
    return Array.from(zhWordSegmenter.segment(value)).filter((segment) => segment.isWordLike).length
  }

  const matches = value.match(/\S+/g)
  return matches ? matches.length : 0
})
const readingMinutes = computed(() => Math.max(1, Math.ceil(Math.max(wordCount.value, charCount.value / 2) / 350)))
const cursorLine = computed(() => cursorState.value.line)
const cursorColumn = computed(() => cursorState.value.column)
const currentModeLabel = computed(() => {
  if (props.mode === 'split') return '分屏'
  return props.mode === 'preview' ? '预览' : '编写'
})
const saveHint = computed(() => {
  if (props.saving) {
    return '正在保存'
  }

  if (props.loading) {
    return '正在加载'
  }

  return '准备编辑'
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

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  const textarea = textareaFromEvent(event)
  if (!textarea) {
    return
  }

  if (event.key === 'Tab') {
    event.preventDefault()
    const result = event.shiftKey
      ? outdentSelection({ snapshot: snapshotFromTextarea(textarea) })
      : indentSelection({ snapshot: snapshotFromTextarea(textarea) })
    await applyResult(result)
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
  return baseName || 'image'
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
        const markdown = urls.map((url, index) => `![${placeholders[index]?.alt || 'image'}](${url})`)
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

</style>
