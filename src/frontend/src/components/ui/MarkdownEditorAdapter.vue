<template>
  <div class="editor-shell-minimal">
    <header class="editor-shell__header mb-6 pb-4 border-b border-[var(--fsusblog-panel-border)]">
      <div class="editor-shell__meta">
        <span class="editor-shell__title text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-primary)]" id="markdown-editor-title">Markdown 编辑器</span>
        <span class="text-[9px] tabular-nums font-bold normal-case tracking-normal px-2 py-0.5 border border-[var(--fsusblog-panel-border)] text-[var(--fsusblog-text-muted)] rounded-[var(--fsus-radius-control-small)]">{{ provider.label }}</span>
        <span
          v-if="loading || saving"
          class="text-[9px] font-bold normal-case tracking-normal "
          :class="saving ? 'text-[var(--fsusblog-color-warning-text)]' : 'text-[var(--fsusblog-text-muted)]'"
        >
          {{ saving ? 'Saving...' : 'Loading...' }}
        </span>
      </div>
      <el-radio-group v-model="mode" size="small" :disabled="loading">
        <el-radio-button value="write">编写</el-radio-button>
        <el-radio-button value="preview">预览</el-radio-button>
      </el-radio-group>
    </header>

    <div class="editor-shell__body">
      <component
        v-show="mode === 'write'"
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
        @on-upload-img="handleUploadImg"
      />

      <div v-show="mode === 'preview'" :class="['preview-panel', previewClass]" role="region" aria-label="Markdown 预览">
        <div class="preview-panel__scroll">
          <div class="preview-panel__scroll-frame">
            <el-scrollbar>
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
                <el-empty
                  v-else-if="!content.trim()"
                  description="当前没有可预览内容"
                />
                <component
                  :is="provider.previewComponent"
                  v-else
                  :content="content"
                />
              </div>
            </el-scrollbar>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
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
  (e: 'upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void
}>()

const provider = computed(() => resolveMarkdownEditorProvider())
const mode = ref<MarkdownEditorMode>(provider.value.defaultMode)

const content = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const mergedToolbarsExclude = computed(() => {
  return Array.from(new Set([...(props.toolbarsExclude || []), ...provider.value.defaultToolbarsExclude]))
})

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void => {
  emit('upload-img', files, callback, onError)
}
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
}

.preview-panel__scroll-frame {
  height: 100%;
}

.preview-panel__view {
  min-height: 100%;
  padding: 0;
}

.preview-panel__loading {
  padding: 24px 0;
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

</style>
