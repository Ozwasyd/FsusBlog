<template>
    <MarkdownEditorAdapter
        ref="adapterRef"
        v-model="content"
        textarea-id="article-content"
        textarea-name="articleContent"
        placeholder="从这里开始写正文。"
        :editor-class="editorSizingClass"
        :preview-class="previewSizingClass"
        :preview-component="ArticleBodyMarkdownPreview"
        :toolbars-exclude="['save']"
        :loading="loading"
        :saving="saving"
        :status-text="statusText"
        :status-tone="statusTone"
        @save="$emit('draft-save')"
        @draft-save="$emit('draft-save')"
        @submit="$emit('submit')"
        @upload-img="handleUploadImg"
    />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import ArticleBodyMarkdownPreview from '@/components/admin/article/ArticleBodyMarkdownPreview.vue';
import MarkdownEditorAdapter from '@/components/ui/MarkdownEditorAdapter.vue';

type EditorLayoutMode = 'standard' | 'focus' | 'fullscreen';

const props = withDefaults(defineProps<{
    modelValue: string;
    loading?: boolean;
    saving?: boolean;
    statusText?: string;
    statusTone?: 'quiet' | 'danger';
    layoutMode?: EditorLayoutMode;
}>(), {
    layoutMode: 'standard',
    statusText: '',
    statusTone: 'quiet'
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'save'): void;
    (e: 'draft-save'): void;
    (e: 'submit'): void;
    (e: 'upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void;
}>();

const adapterRef = ref<{ insertMarkdownAtCursor?: (markdown: string) => boolean; } | null>(null);

const content = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value)
});

const editorSizingClass = computed(() =>
{
    if (props.layoutMode === 'fullscreen')
    {
        return 'h-[min(980px,calc(var(--fsus-viewport-block-size)-190px))] min-h-[720px] max-lg:h-[760px] max-lg:min-h-[560px] max-sm:h-[620px] max-sm:min-h-[460px]';
    }

    if (props.layoutMode === 'focus')
    {
        return 'h-[min(900px,calc(var(--fsus-viewport-block-size)-250px))] min-h-[640px] max-lg:h-[700px] max-lg:min-h-[520px] max-sm:h-[580px] max-sm:min-h-[440px]';
    }

    return 'h-[min(760px,calc(var(--fsus-viewport-block-size)-310px))] min-h-[520px] max-lg:h-[620px] max-lg:min-h-[460px] max-sm:h-[560px] max-sm:min-h-[420px]';
});
const previewSizingClass = computed(() => `preview-panel ${editorSizingClass.value}`);

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void =>
{
    emit('upload-img', files, callback, onError);
};

function insertMarkdownAtCursor(markdown: string): boolean
{
    return adapterRef.value?.insertMarkdownAtCursor?.(markdown) === true;
}

defineExpose({
    insertMarkdownAtCursor
});
</script>
