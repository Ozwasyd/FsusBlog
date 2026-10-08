<template>
    <ElFormItem
        class="write-title-item"
        data-article-form-property="title"
        prop="title"
    >
        <div class="write-title-field">
            <ElInput
                :model-value="modelValue"
                class="write-title-input"
                label="文章标题"
                name="articleTitle"
                placeholder="写下文章标题"
                type="textarea"
                textarea-variant="editor-title"
                :csp-safe="true"
                :autosize="{ minRows: 1, maxRows: 5 }"
                maxlength="100"
                show-word-limit
                :disabled="disabled"
                @update:model-value="$emit('update:modelValue', $event)"
            />
        </div>
    </ElFormItem>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
    modelValue: string;
    disabled?: boolean;
}>(), {
    disabled: false
});

defineEmits<(e: 'update:modelValue', value: string) => void>();
</script>

<style scoped>
.write-title-item,
.write-title-field,
.write-title-input
 {
    width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-all;
}

.write-title-input
 {
    --fsus-editor-title-text-color: var(--fsusblog-text-primary);
    --fsus-editor-title-placeholder-color: var(--fsusblog-text-muted);
    --fsus-editor-title-count-color: var(--fsusblog-text-tertiary);
    --fsus-editor-title-border-color: var(--fsusblog-panel-border);
}

</style>
