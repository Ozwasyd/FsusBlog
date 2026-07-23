<template>
  <el-form-item class="write-title-item" prop="title">
    <div class="write-title-field">
      <el-input
        :model-value="modelValue"
        class="write-title-input"
        label="文章标题"
        name="articleTitle"
        placeholder="写下文章标题"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 3 }"
        maxlength="100"
        show-word-limit
        :disabled="disabled"
        @update:model-value="$emit('update:modelValue', $event)"
      />
    </div>
  </el-form-item>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  modelValue: string
  disabled?: boolean
}>(), {
  disabled: false
})

defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()
</script>

<style scoped>
.write-title-item,
.write-title-item :deep(.el-form-item__content),
.write-title-field,
.write-title-input {
  width: 100%;
  min-width: 0;
}

.write-title-input :deep(.el-textarea__inner) {
  min-height: 4.625rem !important;
  resize: none;
  overflow-wrap: anywhere;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
  padding: 0.875rem clamp(1rem, 3vw, 1.5rem);
  color: var(--fsusblog-text-primary);
  font-family: inherit;
  font-size: clamp(2.25rem, 2.8vw, 2.5rem);
  font-weight: 650;
  line-height: 1.2;
  letter-spacing: 0;
}

.write-title-input :deep(.el-textarea__inner:hover),
.write-title-input :deep(.el-textarea__inner:focus) {
  border-bottom-color: var(--fsusblog-panel-border);
}

.write-title-input :deep(.el-textarea__inner::placeholder) {
  color: var(--fsusblog-text-muted);
  font-weight: 600;
  opacity: 0.78;
}

.write-title-input :deep(.el-input__count) {
  right: clamp(1rem, 3vw, 1.5rem);
  bottom: 0.35rem;
  background: transparent;
  color: var(--fsusblog-text-tertiary);
  font-size: 12px;
  font-weight: 600;
}

@media (max-width: 640px) {
  .write-title-input :deep(.el-textarea__inner) {
    min-height: 4.25rem !important;
    padding: 0.875rem 0.5rem;
    font-size: 1.875rem;
    line-height: 1.2;
  }

  .write-title-input :deep(.el-input__count) {
    display: none;
  }
}

</style>
