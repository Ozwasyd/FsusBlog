<template>
  <MarkdownEditorAdapter
    v-model="content"
    textarea-id="article-content"
    textarea-name="articleContent"
    placeholder="写下正文，支持 Markdown 内容..."
    editor-class="modern-md-editor"
    preview-class="preview-panel"
    :toolbars-exclude="['save']"
    :loading="loading"
    :saving="saving"
    @save="$emit('save')"
    @upload-img="handleUploadImg"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import MarkdownEditorAdapter from '@/components/ui/MarkdownEditorAdapter.vue'

const props = defineProps<{
  modelValue: string
  loading?: boolean
  saving?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'save'): void
  (e: 'upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void
}>()

const content = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void => {
  emit('upload-img', files, callback, onError)
}
</script>

<style scoped>
:deep(.modern-md-editor) {
  height: min(760px, calc(100dvh - 310px));
  min-height: 520px;
  border: none !important;
}

:deep(.preview-panel) {
  height: min(760px, calc(100dvh - 310px));
  min-height: 520px;
}

@media (max-width: 1024px) {
  :deep(.modern-md-editor) {
    height: 620px;
    min-height: 460px;
  }

  :deep(.preview-panel) {
    height: 620px;
    min-height: 460px;
  }
}

@media (max-width: 640px) {
  :deep(.modern-md-editor),
  :deep(.preview-panel) {
    height: 560px;
    min-height: 420px;
  }
}
</style>
