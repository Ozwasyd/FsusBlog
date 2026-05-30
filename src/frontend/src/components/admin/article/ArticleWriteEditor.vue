<template>
  <MarkdownEditorAdapter
    v-model="content"
    textarea-id="article-content"
    textarea-name="articleContent"
    placeholder="写下正文，支持 Markdown 内容..."
    :editor-class="editorSizingClass"
    :preview-class="previewSizingClass"
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

const editorSizingClass = 'h-[min(760px,calc(100dvh-310px))] min-h-[520px] max-lg:h-[620px] max-lg:min-h-[460px] max-sm:h-[560px] max-sm:min-h-[420px]'
const previewSizingClass = `preview-panel ${editorSizingClass}`

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void => {
  emit('upload-img', files, callback, onError)
}
</script>
