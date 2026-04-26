<template>
  <el-card class="editor-shell" shadow="never">
    <template #header>
      <div class="editor-shell__header">
        <div class="editor-shell__meta">
          <span class="editor-shell__title" id="markdown-editor-title">Markdown 编辑器</span>
          <el-tag size="small" type="info" effect="plain">{{ provider.label }}</el-tag>
          <el-tag
            v-if="loading || saving"
            size="small"
            :type="saving ? 'warning' : 'info'"
            effect="light"
          >
            {{ saving ? '保存中' : '加载中' }}
          </el-tag>
        </div>
        <el-button-group role="group" aria-label="编辑器显示模式">
          <el-button
            size="small"
            :type="mode === 'write' ? 'primary' : 'default'"
            :disabled="loading"
            :aria-pressed="String(mode === 'write')"
            @click="mode = 'write'"
          >
            编写
          </el-button>
          <el-button
            size="small"
            :type="mode === 'preview' ? 'primary' : 'default'"
            :disabled="loading"
            :aria-pressed="String(mode === 'preview')"
            @click="mode = 'preview'"
          >
            预览
          </el-button>
        </el-button-group>
      </div>
    </template>

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
        <el-scrollbar class="preview-panel__scroll">
          <div v-if="loading" class="preview-panel__loading">
            <el-skeleton animated>
              <template #template>
                <el-skeleton-item variant="h1" style="width: 48%; height: 28px;" />
                <el-skeleton-item variant="text" style="margin-top: 18px; width: 100%;" />
                <el-skeleton-item variant="text" style="margin-top: 10px; width: 92%;" />
                <el-skeleton-item variant="text" style="margin-top: 10px; width: 88%;" />
                <el-skeleton-item variant="text" style="margin-top: 10px; width: 95%;" />
              </template>
            </el-skeleton>
          </div>
          <el-empty
            v-else-if="!content.trim()"
            description="当前没有可预览内容"
            :image-size="84"
          />
          <component
            :is="provider.previewComponent"
            v-else
            :content="content"
          />
        </el-scrollbar>
      </div>
    </div>
  </el-card>
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
.editor-shell {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--el-border-color-light);
  border-radius: 24px;
  min-width: 0;
  overflow: hidden;
}

.editor-shell :deep(.el-card__header) {
  padding: 14px 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: #fcfcfc;
}

.editor-shell :deep(.el-card__body) {
  padding: 0;
}

.editor-shell__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-width: 0;
}

.editor-shell__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  min-width: 0;
}

.editor-shell__title {
  font-size: 0.95rem;
  font-weight: 700;
  color: #18181b;
}

.preview-panel {
  height: 100%;
  background: #fcfcfc;
}

.preview-panel__scroll {
  height: 100%;
}

.preview-panel :deep(.el-scrollbar__view) {
  min-height: 100%;
  padding: 24px;
}

.preview-panel__loading {
  padding: 24px;
}

.editor-shell__body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.editor-shell :deep(.el-button:focus-visible) {
  outline: 2px solid #2A599C;
  outline-offset: 2px;
}

.editor-shell :deep(.el-empty) {
  min-height: 320px;
}
</style>
