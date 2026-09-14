<template>
  <div
    class="editor-shell-minimal"
    role="region"
    :aria-labelledby="labelledBy"
    :aria-label="labelledBy ? undefined : accessibleName"
    :data-markdown-chrome="chrome"
    :data-status-density="statusDensity"
  >
    <component
      ref="editorRef"
      :is="provider.editorComponent"
      v-model="content"
      :placeholder="placeholder"
      :textarea-id="textareaId"
      :textarea-name="textareaName"
      :mode="resolvedMode"
      :chrome="chrome"
      :status-density="statusDensity"
      :show-mode-switcher="showModeSwitcher"
      :toolbar-density="toolbarDensity"
      :loading="loading"
      :saving="saving"
      :class="editorClass"
      :toolbars-exclude="mergedToolbarsExclude"
      @on-save="emit('save')"
      @on-draft-save="emit('draft-save')"
      @on-submit="emit('submit')"
      @on-upload-img="handleUploadImg"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { resolveMarkdownEditorProvider } from '@/components/ui/markdownEditorProvider'
import type {
  MarkdownEditorChrome,
  MarkdownEditorMode,
  MarkdownEditorStatusDensity
} from '@/ui-contracts/markdownEditor'

defineOptions({ name: 'MarkdownEditorAdapter' })

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  textareaId?: string
  textareaName?: string
  editorClass?: string
  labelledBy?: string
  accessibleName?: string
  toolbarsExclude?: string[]
  loading?: boolean
  saving?: boolean
  mode?: MarkdownEditorMode
  chrome?: MarkdownEditorChrome
  statusDensity?: MarkdownEditorStatusDensity
  showModeSwitcher?: boolean
  toolbarDensity?: 'minimal' | 'standard' | 'full'
}>(), {
  placeholder: '',
  textareaId: undefined,
  textareaName: 'markdownContent',
  editorClass: '',
  labelledBy: undefined,
  accessibleName: '正文',
  loading: false,
  saving: false,
  mode: 'source',
  chrome: 'framed',
  statusDensity: 'minimal',
  showModeSwitcher: true,
  toolbarDensity: 'standard'
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'save'): void
  (e: 'draft-save'): void
  (e: 'submit'): void
  (e: 'upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void
}>()

const provider = computed(() => resolveMarkdownEditorProvider())
const editorRef = ref<{ insertMarkdownAtCursor?: (markdown: string) => boolean } | null>(null)

const content = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const resolvedMode = computed<MarkdownEditorMode>(() => props.mode)
const mergedToolbarsExclude = computed(() => {
  return Array.from(new Set([...(props.toolbarsExclude || []), ...provider.value.defaultToolbarsExclude]))
})

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void => {
  emit('upload-img', files, callback, onError)
}

function insertMarkdownAtCursor(markdown: string): boolean {
  return editorRef.value?.insertMarkdownAtCursor?.(markdown) === true
}

defineExpose({
  insertMarkdownAtCursor
})
</script>

<style scoped>
.editor-shell-minimal {
  display: flex;
  flex-direction: column;
  width: 100%;
  align-self: stretch;
  min-width: 0;
}
</style>
