<template>
  <div class="editor-container account-soft-block overflow-hidden" :class="{ 'is-loading': loading }">
    <MarkdownEditorAdapter
      v-model="content"
      editor-class="settings-editor h-112.5 sm:h-150!"
      preview-class="settings-preview-wrapper h-112.5 sm:h-150!"
      :loading="loading"
      :saving="saving"
    />
  </div>
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
}>()

const content = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value)
})
</script>

<style scoped>
.editor-container {
  border-radius: var(--fsus-radius-lg);
  background: rgba(252, 252, 252, 0.92);
}

.editor-container :deep(.settings-editor) {
  border: none !important;
}

.editor-container :deep(.settings-preview-wrapper) {
  scrollbar-width: thin;
  scrollbar-color: #e4e4e7 transparent;
}

@media (max-width: 640px) {
  .editor-container :deep(.settings-editor) {
    height: 400px !important;
  }

  .editor-container :deep(.settings-preview-wrapper) {
    height: 400px !important;
  }
}
</style>
