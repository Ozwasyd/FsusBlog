<template>
  <div class="editor-container-minimal" :class="{ 'is-loading': loading }">
    <MarkdownEditorAdapter
      v-model="content"
      editor-class="settings-editor h-[400px] sm:h-[600px]"
      preview-class="settings-preview-wrapper h-[400px] sm:h-[600px]"
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
.editor-container-minimal {
  width: 100%;
}
</style>
