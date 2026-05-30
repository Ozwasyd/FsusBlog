<template>
  <div class="markdown-text-editor">
    <div class="markdown-text-editor__toolbar" role="toolbar" aria-label="Markdown 编辑工具栏">
      <el-tooltip
        v-for="command in toolbarCommands"
        :key="command.key"
        :content="commandTooltip(command)"
        placement="top"
      >
        <el-button
          size="small"
          :disabled="isBusy && command.key !== 'save'"
          :aria-label="command.ariaLabel || command.label"
          @click="runToolbarCommand(command.key)"
        >
          {{ command.label }}
        </el-button>
      </el-tooltip>
    </div>

    <textarea
      ref="textareaRef"
      v-model="localValue"
      :id="textareaId"
      :name="textareaName"
      class="markdown-text-editor__textarea"
      :placeholder="placeholder"
      :disabled="isBusy"
      :aria-describedby="statusId"
      aria-label="Markdown 正文编辑区"
      spellcheck="false"
      @keydown="handleKeydown"
      @paste="handlePaste"
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
      <span>{{ saveHint }}</span>
      <span v-if="loading">编辑器初始化中</span>
      <span v-else-if="saving">内容正在写入</span>
      <span v-else-if="isUploading">图片上传中</span>
      <span v-else-if="uploadError">{{ uploadError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { MarkdownEditorCommand, MarkdownEditorCommandKey, MarkdownEditorMode } from '@/ui-contracts/markdownEditor'
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
  (e: 'on-upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)
const statusId = `markdown-editor-status-${Math.random().toString(36).slice(2, 9)}`
const historyStack = ref<SelectionSnapshot[]>([])
const redoStack = ref<SelectionSnapshot[]>([])
const isUploading = ref(false)
const uploadError = ref('')

const localValue = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const lineCount = computed(() => (localValue.value ? localValue.value.split('\n').length : 1))
const charCount = computed(() => localValue.value.length)
const wordCount = computed(() => {
  const matches = localValue.value.trim().match(/\S+/g)
  return matches ? matches.length : 0
})
const toolbarCommands = computed(() => markdownEditorCommands.filter((command) => !props.toolbarsExclude.includes(command.key)))
const isBusy = computed(() => isUploading.value || props.saving || props.loading)
const currentModeLabel = computed(() => props.mode === 'preview' ? '预览' : '编写')
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
  return command.ariaLabel || command.label
}

function snapshotFromTextarea(): SelectionSnapshot {
  const textarea = textareaRef.value
  const start = textarea?.selectionStart ?? localValue.value.length
  const end = textarea?.selectionEnd ?? start

  return createSnapshot(localValue.value, start, end)
}

function pushHistory(snapshot = snapshotFromTextarea()): void {
  historyStack.value.push(snapshot)
  if (historyStack.value.length > 100) {
    historyStack.value.shift()
  }
}

async function focusResult(result: SelectionResult): Promise<void> {
  await nextTick()
  textareaRef.value?.focus()
  textareaRef.value?.setSelectionRange(result.start, result.end)
}

async function applyResult(result: SelectionResult, pushCurrent = true): Promise<void> {
  if (pushCurrent) {
    pushHistory()
  }
  redoStack.value = []
  localValue.value = result.value
  await focusResult(result)
}

async function runToolbarCommand(key: MarkdownEditorCommandKey): Promise<void> {
  if (key === 'image') {
    imageInputRef.value?.click()
    return
  }

  if (key === 'save') {
    emit('on-save')
    return
  }

  if (key === 'undo') {
    await performUndo()
    return
  }

  if (key === 'redo') {
    await performRedo()
    return
  }

  const result = executeMarkdownEditorCommand(key, {
    snapshot: snapshotFromTextarea()
  })
  await applyResult(result)
}

async function performUndo(): Promise<void> {
  const previous = historyStack.value.pop()
  if (!previous) {
    return
  }

  redoStack.value.push(snapshotFromTextarea())
  localValue.value = previous.value
  await focusResult({
    value: previous.value,
    start: previous.start,
    end: previous.end
  })
}

async function performRedo(): Promise<void> {
  const next = redoStack.value.pop()
  if (!next) {
    return
  }

  pushHistory()
  localValue.value = next.value
  await focusResult({
    value: next.value,
    start: next.start,
    end: next.end
  })
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

  emit(
    'on-upload-img',
    files,
    async (urls) => {
      try {
        const markdown = urls.map((url) => `![image](${url})`).join('\n')
        await applyResult(replaceSelection(snapshot, markdown))
      } finally {
        isUploading.value = false
      }
    },
    (message) => {
      uploadError.value = message
      isUploading.value = false
    }
  )
}

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    emit('on-save')
    return
  }

  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    await performUndo()
    return
  }

  if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y')
    || ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'z')) {
    event.preventDefault()
    await performRedo()
    return
  }

  if (event.key === 'Tab') {
    event.preventDefault()
    const result = event.shiftKey
      ? outdentSelection({ snapshot: snapshotFromTextarea() })
      : indentSelection({ snapshot: snapshotFromTextarea() })
    await applyResult(result)
  }
}

watch(() => props.modelValue, () => {
  uploadError.value = ''
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
  gap: 0.5rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-panel-bg);
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

  .markdown-text-editor__textarea {
    padding: 1rem;
    font-size: 0.9rem;
  }
}
</style>
