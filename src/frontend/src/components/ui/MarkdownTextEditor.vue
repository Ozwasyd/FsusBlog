<template>
  <div class="markdown-text-editor">
    <div class="markdown-text-editor__toolbar" role="toolbar" aria-label="Markdown 编辑工具栏">
      <div
        v-for="group in toolbarGroups"
        :key="group.key"
        class="markdown-text-editor__toolbar-group"
        :aria-label="group.label"
      >
        <el-tooltip
          v-for="command in group.commands"
          :key="command.key"
          :content="commandTooltip(command)"
          placement="top"
        >
          <el-button
            size="small"
            :disabled="commandDisabled(command)"
            :aria-label="command.ariaLabel || command.label"
            @click="runToolbarCommand(command.key)"
          >
            {{ command.label }}
          </el-button>
        </el-tooltip>
      </div>
    </div>

    <textarea
      ref="textareaRef"
      v-model="localValue"
      :id="textareaId"
      :name="textareaName"
      class="markdown-text-editor__textarea"
      :placeholder="placeholder"
      :disabled="editorDisabled"
      :aria-describedby="`${helpId} ${statusId}`"
      aria-label="Markdown 正文编辑区"
      spellcheck="false"
      @keydown="handleKeydown"
      @paste="handlePaste"
      @click="rememberSelection"
      @keyup="rememberSelection"
      @select="rememberSelection"
      @focus="rememberSelection"
    />

    <input
      ref="imageInputRef"
      type="file"
      accept="image/*"
      class="hidden"
      aria-hidden="true"
      tabindex="-1"
      @change="handleImagePick"
    />

    <div :id="statusId" class="markdown-text-editor__status" role="status" aria-live="polite">
      <span>模式 {{ currentModeLabel }}</span>
      <span>行 {{ lineCount }}</span>
      <span>字 {{ charCount }}</span>
      <span>词 {{ wordCount }}</span>
      <span>约 {{ readingMinutes }} 分钟</span>
      <span>Ln {{ cursorLine }}, Col {{ cursorColumn }}</span>
      <span :id="helpId">Tab 缩进，Shift+Tab 反缩进，Esc 离开编辑区</span>
      <span>{{ saveHint }}</span>
      <span v-if="loading">编辑器初始化中</span>
      <span v-else-if="saving">内容正在写入</span>
      <span v-else-if="isUploading">图片上传中，可继续编辑</span>
      <span v-else-if="uploadError">{{ uploadError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type {
  MarkdownEditorCommand,
  MarkdownEditorCommandGroup,
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

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)
const statusId = `markdown-editor-status-${Math.random().toString(36).slice(2, 9)}`
const helpId = `markdown-editor-help-${Math.random().toString(36).slice(2, 9)}`
const isUploading = ref(false)
const uploadError = ref('')
const lastSelection = ref<SelectionSnapshot | null>(null)
const cursorState = ref({ line: 1, column: 1 })

type WordSegment = { isWordLike?: boolean }
type WordSegmenter = { segment: (input: string) => Iterable<WordSegment> }
type WordSegmenterConstructor = new (locale: string, options: { granularity: 'word' }) => WordSegmenter

const SegmenterCtor = (Intl as typeof Intl & { Segmenter?: WordSegmenterConstructor }).Segmenter
const zhWordSegmenter = SegmenterCtor ? new SegmenterCtor('zh', { granularity: 'word' }) : null

const toolbarGroupLabels: Readonly<Record<MarkdownEditorCommandGroup, string>> = {
  text: '文本',
  structure: '结构',
  code: '代码与公式',
  media: '媒体',
  action: '操作'
}
const toolbarGroupOrder: readonly MarkdownEditorCommandGroup[] = ['text', 'structure', 'code', 'media', 'action']

const localValue = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

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
const toolbarCommands = computed(() => markdownEditorCommands.filter((command) =>
  !props.toolbarsExclude.includes(command.key)
  && command.key !== 'undo'
  && command.key !== 'redo'))
const toolbarGroups = computed(() => toolbarGroupOrder
  .map((group) => ({
    key: group,
    label: toolbarGroupLabels[group],
    commands: toolbarCommands.value.filter((command) => command.group === group)
  }))
  .filter((group) => group.commands.length > 0))
const editorDisabled = computed(() => props.saving || props.loading)
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

function commandTooltip(command: MarkdownEditorCommand): string {
  const label = command.ariaLabel || command.label
  return command.shortcut ? `${label} (${command.shortcut})` : label
}

function commandDisabled(command: MarkdownEditorCommand): boolean {
  if (command.key === 'save') {
    return props.loading
  }

  return editorDisabled.value
}

function snapshotFromTextarea(): SelectionSnapshot {
  const textarea = textareaRef.value
  const start = textarea?.selectionStart ?? localValue.value.length
  const end = textarea?.selectionEnd ?? start

  return createSnapshot(localValue.value, start, end)
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

function rememberSelection(): void {
  const textarea = textareaRef.value
  if (!textarea) {
    return
  }

  const snapshot = snapshotFromTextarea()
  lastSelection.value = snapshot
  cursorState.value = cursorFromIndex(snapshot.value, snapshot.start)
}

async function focusResult(result: SelectionResult): Promise<void> {
  await nextTick()
  textareaRef.value?.focus()
  textareaRef.value?.setSelectionRange(result.start, result.end)
  rememberSelection()
}

async function applyResult(result: SelectionResult): Promise<void> {
  localValue.value = result.value
  await focusResult(result)
}

function insertMarkdownAtCursor(markdown: string): boolean {
  const snapshot = lastSelection.value
  if (!snapshot) {
    return false
  }

  void applyResult(replaceSelection(snapshot, markdown))
  return true
}

async function runToolbarCommand(key: MarkdownEditorCommandKey): Promise<void> {
  if (key === 'image') {
    imageInputRef.value?.click()
    return
  }

  if (key === 'save') {
    emit('on-draft-save')
    emit('on-save')
    return
  }

  if (key === 'undo' || key === 'redo') {
    return
  }

  const result = executeMarkdownEditorCommand(key, {
    snapshot: snapshotFromTextarea()
  })
  await applyResult(result)
}

async function handleImagePick(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null
  const files = Array.from(input?.files || [])
  if (!files.length) {
    return
  }

  await uploadImages(files, snapshotFromTextarea())

  if (input) {
    input.value = ''
  }
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

function handlePaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))
  if (files.length) {
    event.preventDefault()
    void uploadImages(files, snapshotFromTextarea())
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

  await applyResult(replaceSelection(snapshot, placeholders.map((placeholder) => placeholder.token).join('\n')))

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

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    emit('on-draft-save')
    return
  }

  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    emit('on-submit')
    return
  }

  if (event.key === 'Tab') {
    event.preventDefault()
    const result = event.shiftKey
      ? outdentSelection({ snapshot: snapshotFromTextarea() })
      : indentSelection({ snapshot: snapshotFromTextarea() })
    await applyResult(result)
    return
  }

  if (event.key === 'Escape') {
    focusNextControl()
  }
}

function focusNextControl(): void {
  const textarea = textareaRef.value
  if (!textarea) {
    return
  }

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
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--fsusblog-panel-bg);
}

.markdown-text-editor__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-panel-bg);
}

.markdown-text-editor__toolbar-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-width: 0;
  padding-right: 0.75rem;
  border-right: 1px solid var(--fsusblog-panel-border);
}

.markdown-text-editor__toolbar-group:last-child {
  padding-right: 0;
  border-right: none;
}

.markdown-text-editor__textarea::placeholder {
  color: var(--fsusblog-text-muted);
}

.markdown-text-editor__textarea {
  width: 100%;
  flex: 1;
  min-height: 0;
  resize: none;
  border: none;
  outline: none;
  padding: 1.5rem;
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-text-primary);
  font-family: var(--font-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  font-size: 0.95rem;
  line-height: 1.75;
}

.markdown-text-editor__textarea:focus-visible {
  box-shadow: inset 0 0 0 1px var(--fsusblog-color-focus-ring);
}

.markdown-text-editor__status {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  padding: 0.65rem 1rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  color: var(--fsusblog-text-tertiary);
  font-size: 0.72rem;
  font-weight: 600;
}

@media (max-width: 640px) {
  .markdown-text-editor__toolbar {
    gap: 0.375rem;
    padding: 0.75rem;
  }

  .markdown-text-editor__toolbar-group {
    padding-right: 0.5rem;
  }

  .markdown-text-editor__textarea {
    padding: 1rem;
    font-size: 0.9rem;
  }
}
</style>
