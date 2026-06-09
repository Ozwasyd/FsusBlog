<template>
  <div class="editor-shell-minimal">
    <header class="editor-shell__header mb-6 pb-4 border-b border-[var(--fsusblog-panel-border)]">
      <div class="editor-shell__meta">
        <span class="editor-shell__title text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-primary)]" id="markdown-editor-title">Markdown 编辑器</span>
        <span class="text-[11px] tabular-nums font-bold normal-case tracking-normal px-2 py-0.5 border border-[var(--fsusblog-panel-border)] text-[var(--fsusblog-text-muted)] rounded-[var(--fsus-radius-control-small)]">{{ provider.label }}</span>
        <span
          v-if="loading || saving"
          class="text-[11px] font-bold normal-case tracking-normal "
          :class="saving ? 'text-[var(--fsusblog-color-warning-text)]' : 'text-[var(--fsusblog-text-muted)]'"
        >
          {{ saving ? 'Saving...' : 'Loading...' }}
        </span>
      </div>
      <el-radio-group v-model="mode" size="small" :disabled="loading">
        <el-radio-button value="write">编写</el-radio-button>
        <el-radio-button class="editor-shell__split-option" value="split">分屏</el-radio-button>
        <el-radio-button value="preview">预览</el-radio-button>
      </el-radio-group>
    </header>

    <div class="editor-shell__body" :class="{ 'editor-shell__body--split': mode === 'split' }">
      <component
        ref="editorRef"
        v-show="mode === 'write' || mode === 'split'"
        :is="provider.editorComponent"
        v-model="content"
        :placeholder="placeholder"
        :textarea-id="textareaId"
        :textarea-name="textareaName"
        :mode="mode"
        :loading="loading"
        :saving="saving"
        :class="editorClass"
        aria-labelledby="markdown-editor-title"
        :toolbars-exclude="mergedToolbarsExclude"
        @on-save="emit('save')"
        @on-draft-save="emit('draft-save')"
        @on-submit="emit('submit')"
        @on-upload-img="handleUploadImg"
      />

      <div v-if="isPreviewMounted" :class="['preview-panel', previewClass]" role="region" aria-label="Markdown 预览">
        <div class="preview-panel__scroll">
          <div class="preview-panel__view">
            <div v-if="loading" class="preview-panel__loading">
              <el-skeleton animated>
                <template #template>
                  <div class="preview-skeleton-line preview-skeleton-line--title">
                    <el-skeleton-item variant="h1" />
                  </div>
                  <div class="preview-skeleton-line preview-skeleton-line--full">
                    <el-skeleton-item variant="text" />
                  </div>
                  <div class="preview-skeleton-line preview-skeleton-line--wide">
                    <el-skeleton-item variant="text" />
                  </div>
                  <div class="preview-skeleton-line preview-skeleton-line--medium">
                    <el-skeleton-item variant="text" />
                  </div>
                  <div class="preview-skeleton-line preview-skeleton-line--almost-full">
                    <el-skeleton-item variant="text" />
                  </div>
                </template>
              </el-skeleton>
            </div>
            <div v-else-if="isLargePreviewContent && isManualPreviewStale" class="preview-panel__notice" role="status">
              <p>当前文档较大，预览已暂停自动刷新以降低渲染压力。</p>
              <el-button type="primary" @click="refreshManualPreview">刷新预览</el-button>
            </div>
            <el-empty
              v-else-if="!previewContent.trim()"
              description="当前没有可预览内容"
            />
            <component
              :is="provider.previewComponent"
              v-else
              :content="previewContent"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { resolveMarkdownEditorProvider } from '@/components/ui/markdownEditorProvider'
import type { MarkdownEditorMode } from '@/ui-contracts/markdownEditor'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  textareaId?: string
  textareaName?: string
  editorClass?: string
  previewClass?: string
  toolbarsExclude?: string[]
  loading?: boolean
  saving?: boolean
}>(), {
  placeholder: '',
  textareaId: undefined,
  textareaName: 'markdownContent',
  editorClass: '',
  previewClass: 'preview-panel',
  loading: false,
  saving: false
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'save'): void
  (e: 'draft-save'): void
  (e: 'submit'): void
  (e: 'upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void
}>()

const provider = computed(() => resolveMarkdownEditorProvider())
const mode = ref<MarkdownEditorMode>(provider.value.defaultMode)
const editorRef = ref<{ insertMarkdownAtCursor?: (markdown: string) => boolean } | null>(null)
const debouncedPreviewContent = ref(props.modelValue)
const manualPreviewContent = ref(props.modelValue)
let previewDebounceTimer: ReturnType<typeof setTimeout> | null = null

const MARKDOWN_PREVIEW_DEBOUNCE_MS = 250
const LARGE_PREVIEW_CONTENT_BYTES = 80 * 1024
const LARGE_PREVIEW_NODE_ESTIMATE = 3000

const content = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const isPreviewMounted = computed(() => mode.value === 'preview' || mode.value === 'split')
const estimatedPreviewNodes = computed(() => estimateMarkdownNodeCount(content.value))
const isLargePreviewContent = computed(() =>
  content.value.length > LARGE_PREVIEW_CONTENT_BYTES || estimatedPreviewNodes.value > LARGE_PREVIEW_NODE_ESTIMATE
)
const previewContent = computed(() => isLargePreviewContent.value ? manualPreviewContent.value : debouncedPreviewContent.value)
const isManualPreviewStale = computed(() => manualPreviewContent.value !== content.value)

const mergedToolbarsExclude = computed(() => {
  return Array.from(new Set([...(props.toolbarsExclude || []), ...provider.value.defaultToolbarsExclude]))
})

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void => {
  emit('upload-img', files, callback, onError)
}

watch([content, isPreviewMounted, isLargePreviewContent], ([nextContent, mounted, large]) => {
  if (!mounted) {
    return
  }

  if (large) {
    if (!manualPreviewContent.value) {
      manualPreviewContent.value = nextContent
    }
    return
  }

  if (previewDebounceTimer !== null) {
    clearTimeout(previewDebounceTimer)
  }
  previewDebounceTimer = setTimeout(() => {
    debouncedPreviewContent.value = nextContent
  }, MARKDOWN_PREVIEW_DEBOUNCE_MS)
}, { immediate: true })

onBeforeUnmount(() => {
  if (previewDebounceTimer !== null) {
    clearTimeout(previewDebounceTimer)
  }
})

const refreshManualPreview = (): void => {
  manualPreviewContent.value = content.value
}

function estimateMarkdownNodeCount(value: string): number {
  if (!value) {
    return 0
  }

  const lineCount = value.split(/\r?\n/u).length
  const fencedBlocks = (value.match(/```/g) ?? []).length
  const headings = (value.match(/^#{1,6}\s+/gmu) ?? []).length
  const listItems = (value.match(/^\s*[-*+]\s+/gmu) ?? []).length
  const tables = (value.match(/^\s*\|.*\|\s*$/gmu) ?? []).length
  return lineCount + headings * 2 + listItems * 2 + tables * 3 + fencedBlocks * 30
}

function insertMarkdownAtCursor(markdown: string): boolean {
  return editorRef.value?.insertMarkdownAtCursor?.(markdown) === true
}

defineExpose({
  insertMarkdownAtCursor
})
</script>

<style scoped>
@reference "@/assets/main.css";

.editor-shell-minimal {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.editor-shell__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.editor-shell__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
  min-width: 0;
}

.preview-panel {
  height: 100%;
  background: var(--fsusblog-page-bg);
  border-radius: var(--fsus-radius-control);
}

.preview-panel__scroll {
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.preview-panel__view {
  min-height: 100%;
  padding: 0;
  content-visibility: auto;
  contain-intrinsic-size: 900px;
}

.preview-panel__loading {
  padding: 24px 0;
}

.preview-panel__notice {
  display: grid;
  gap: 1rem;
  padding: 1.25rem;
  border: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg-soft);
  color: var(--fsusblog-text-secondary);
  font-size: 0.875rem;
  line-height: 1.7;
}

.preview-skeleton-line {
  display: block;
}

.preview-skeleton-line--title {
  width: 48%;
}

.preview-skeleton-line--full {
  margin-top: 18px;
  width: 100%;
}

.preview-skeleton-line--wide {
  margin-top: 10px;
  width: 92%;
}

.preview-skeleton-line--medium {
  margin-top: 10px;
  width: 88%;
}

.preview-skeleton-line--almost-full {
  margin-top: 10px;
  width: 95%;
}

.editor-shell__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.editor-shell__body--split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: stretch;
}

@media (max-width: 768px) {
  .editor-shell__body--split {
    grid-template-columns: minmax(0, 1fr);
  }
}

</style>
