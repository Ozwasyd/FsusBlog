<template>
    <div class="editor-shell-minimal">
        <header class="editor-shell__header border-b border-[var(--fsusblog-panel-border)]">
            <div class="editor-shell__meta">
                <span
                    class="editor-shell__title"
                    id="markdown-editor-title"
                >正文</span>
                <span
                    class="editor-shell__status"
                    :class="{ 'editor-shell__status--danger': statusTone === 'danger' }"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                >
                    {{ editorStatusText }}
                </span>
            </div>
            <ElRadioGroup
                class="editor-shell__modes"
                v-model="mode"
                size="small"
                :disabled="loading"
            >
                <ElRadioButton value="write">编辑</ElRadioButton>
                <ElRadioButton
                    v-if="!hideSplitMode"
                    class="editor-shell__split-option"
                    value="split"
                >分屏</ElRadioButton>
                <ElRadioButton value="preview">预览</ElRadioButton>
            </ElRadioGroup>
        </header>

        <div
            class="editor-shell__body"
            :class="{ 'editor-shell__body--split': mode === 'split' }"
        >
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

            <div
                v-if="isPreviewMounted"
                :class="['preview-panel', previewClass]"
                role="region"
                aria-label="Markdown 预览"
            >
                <div class="preview-panel__scroll">
                    <div class="preview-panel__view">
                        <div
                            v-if="loading"
                            class="preview-panel__state preview-panel__loading"
                            role="status"
                            aria-live="polite"
                        >
                            <span class="preview-panel__sr-only">加载中</span>
                            <ElSkeleton animated>
                                <template #template>
                                    <div class="preview-skeleton-line preview-skeleton-line--title">
                                        <ElSkeletonItem variant="h1" />
                                    </div>
                                    <div class="preview-skeleton-line preview-skeleton-line--full">
                                        <ElSkeletonItem variant="text" />
                                    </div>
                                    <div class="preview-skeleton-line preview-skeleton-line--wide">
                                        <ElSkeletonItem variant="text" />
                                    </div>
                                    <div class="preview-skeleton-line preview-skeleton-line--medium">
                                        <ElSkeletonItem variant="text" />
                                    </div>
                                    <div class="preview-skeleton-line preview-skeleton-line--almost-full">
                                        <ElSkeletonItem variant="text" />
                                    </div>
                                </template>
                            </ElSkeleton>
                        </div>
                        <div
                            v-else-if="isLargePreviewContent && isManualPreviewStale"
                            class="preview-panel__state preview-panel__notice"
                            role="status"
                        >
                            <p class="preview-panel__state-title">预览已暂停自动刷新</p>
                            <p class="preview-panel__state-description">当前文档较大，手动刷新可以降低渲染压力。</p>
                            <div class="preview-panel__state-actions">
                                <ElButton
                                    type="primary"
                                    @click="refreshManualPreview"
                                >刷新预览</ElButton>
                            </div>
                        </div>
                        <div
                            v-else-if="!previewContent.trim()"
                            class="preview-panel__state preview-panel__empty"
                            role="status"
                        >
                            <p class="preview-panel__state-title">暂无预览内容</p>
                            <p class="preview-panel__state-description">开始编写后将在这里显示预览。</p>
                        </div>
                        <component
                            :is="resolvedPreviewComponent"
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
import { computed, onBeforeUnmount, ref, watch, type Component } from 'vue';

import { resolveMarkdownEditorProvider } from '@/components/ui/markdownEditorProvider';
import { useMediaQuery } from '@/composables/useMediaQuery';
import type { MarkdownEditorMode } from '@/ui-contracts/markdownEditor';

const props = withDefaults(defineProps<{
    modelValue: string;
    placeholder?: string;
    textareaId?: string;
    textareaName?: string;
    editorClass?: string;
    previewClass?: string;
    previewComponent?: Component;
    toolbarsExclude?: string[];
    loading?: boolean;
    saving?: boolean;
    statusText?: string;
    statusTone?: 'quiet' | 'danger';
}>(), {
    placeholder: '',
    textareaId: undefined,
    textareaName: 'markdownContent',
    editorClass: '',
    previewClass: 'preview-panel',
    loading: false,
    saving: false,
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

const provider = computed(() => resolveMarkdownEditorProvider());
const mode = ref<MarkdownEditorMode>(provider.value.defaultMode);
const editorRef = ref<{ insertMarkdownAtCursor?: (markdown: string) => boolean; } | null>(null);
const debouncedPreviewContent = ref(props.modelValue);
const manualPreviewContent = ref(props.modelValue);
const isNarrowEditor = useMediaQuery('(max-width: 767px)', false);
const isTouchEditor = useMediaQuery('(hover: none) and (pointer: coarse)', false);
let previewDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const MARKDOWN_PREVIEW_DEBOUNCE_MS = 250;
const LARGE_PREVIEW_CONTENT_BYTES = 80 * 1024;
const LARGE_PREVIEW_NODE_ESTIMATE = 3000;

const content = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value)
});

const isPreviewMounted = computed(() => mode.value === 'preview' || mode.value === 'split');
const hideSplitMode = computed(() => isNarrowEditor.value || isTouchEditor.value);
const estimatedPreviewNodes = computed(() => estimateMarkdownNodeCount(content.value));
const isLargePreviewContent = computed(() =>
    content.value.length > LARGE_PREVIEW_CONTENT_BYTES || estimatedPreviewNodes.value > LARGE_PREVIEW_NODE_ESTIMATE
);
const previewContent = computed(() => isLargePreviewContent.value ? manualPreviewContent.value : debouncedPreviewContent.value);
const isManualPreviewStale = computed(() => manualPreviewContent.value !== content.value);
const resolvedPreviewComponent = computed(() => props.previewComponent ?? provider.value.previewComponent);
const editorStatusText = computed(() =>
{
    if (props.statusText.trim())
    {
        return props.statusText.trim();
    }

    if (props.saving)
    {
        return '保存中';
    }

    if (props.loading)
    {
        return '加载中';
    }

    return '';
});

const mergedToolbarsExclude = computed(() =>
{
    return Array.from(new Set([...(props.toolbarsExclude || []), ...provider.value.defaultToolbarsExclude]));
});

watch(hideSplitMode, (hide) =>
{
    if (hide && mode.value === 'split')
    {
        mode.value = 'write';
    }
}, { immediate: true });

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void =>
{
    emit('upload-img', files, callback, onError);
};

watch([content, isPreviewMounted, isLargePreviewContent], ([nextContent, mounted, large]) =>
{
    if (!mounted)
    {
        return;
    }

    if (large)
    {
        if (!manualPreviewContent.value)
        {
            manualPreviewContent.value = nextContent;
        }
        return;
    }

    if (previewDebounceTimer !== null)
    {
        clearTimeout(previewDebounceTimer);
    }
    previewDebounceTimer = setTimeout(() =>
    {
        debouncedPreviewContent.value = nextContent;
    }, MARKDOWN_PREVIEW_DEBOUNCE_MS);
}, { immediate: true });

onBeforeUnmount(() =>
{
    if (previewDebounceTimer !== null)
    {
        clearTimeout(previewDebounceTimer);
    }
});

const refreshManualPreview = (): void =>
{
    manualPreviewContent.value = content.value;
};

function estimateMarkdownNodeCount(value: string): number
{
    if (!value)
    {
        return 0;
    }

    const lineCount = value.split(/\r?\n/u).length;
    const fencedBlocks = (value.match(/```/g) ?? []).length;
    const headings = (value.match(/^#{1,6}\s+/gmu) ?? []).length;
    const listItems = (value.match(/^\s*[-*+]\s+/gmu) ?? []).length;
    const tables = (value.match(/^\s*\|.*\|\s*$/gmu) ?? []).length;
    return lineCount + headings * 2 + listItems * 2 + tables * 3 + fencedBlocks * 30;
}

function insertMarkdownAtCursor(markdown: string): boolean
{
    return editorRef.value?.insertMarkdownAtCursor?.(markdown) === true;
}

defineExpose({
    insertMarkdownAtCursor
});
</script>

<style scoped>
@reference "@/assets/main.css";

.editor-shell-minimal
 {
    display: flex;
    flex-direction: column;
    width: 100%;
    align-self: stretch;
    min-width: 0;
}

.editor-shell__header
 {
    box-sizing: border-box;
    display: grid;
    height: 2.5rem;
    align-items: center;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    width: 100%;
    min-width: 0;
}

.editor-shell__meta
 {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
}

.editor-shell__title,
.editor-shell__status
 {
    font-size: 14px;
    font-weight: 500;
    line-height: 1.25;
}

.editor-shell__title
 {
    flex: 0 0 auto;
    color: var(--fsusblog-text-primary);
    font-weight: 700;
}

.editor-shell__status
 {
    width: 12rem;
    min-width: 0;
    overflow: hidden;
    color: var(--fsusblog-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.editor-shell__status--danger
 {
    color: var(--fsusblog-color-danger);
}

.editor-shell__modes
 {
    flex: 0 0 auto;
    margin-left: auto;
}

@media (width <= 640px)
 {
    .editor-shell__meta
 {
        gap: 0.5rem;
    }

    .editor-shell__status
 {
        width: 7rem;
    }
}

.preview-panel
 {
    width: 100%;
    min-width: 0;
    height: 100%;
    background: var(--fsusblog-page-bg);
    border-radius: var(--fsus-radius-control);
}

.preview-panel__scroll
 {
    height: 100%;
    min-height: 0;
    overflow: auto;
}

.preview-panel__view
 {
    min-height: 100%;
    padding: 0;
    content-visibility: auto;
    contain-intrinsic-size: 900px;
}

.preview-panel__state
 {
    display: grid;
    gap: 0.5rem;
    padding: 1.5rem 0;
    color: var(--fsusblog-text-secondary);
    font-size: 14px;
    line-height: 1.7;
}

.preview-panel__loading
 {
    padding: 24px 0;
}

.preview-panel__state-title,
.preview-panel__state-description
 {
    margin: 0;
}

.preview-panel__state-title
 {
    color: var(--fsusblog-text-primary);
    font-weight: 700;
}

.preview-panel__state-description
 {
    color: var(--fsusblog-text-tertiary);
}

.preview-panel__state-actions
 {
    margin-top: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
}

.preview-panel__notice
 {
    border-top: 1px solid var(--fsusblog-panel-border);
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.preview-panel__sr-only
 {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

.preview-skeleton-line
 {
    display: block;
}

.preview-skeleton-line--title
 {
    width: 48%;
}

.preview-skeleton-line--full
 {
    margin-top: 18px;
    width: 100%;
}

.preview-skeleton-line--wide
 {
    margin-top: 10px;
    width: 92%;
}

.preview-skeleton-line--medium
 {
    margin-top: 10px;
    width: 88%;
}

.preview-skeleton-line--almost-full
 {
    margin-top: 10px;
    width: 95%;
}

.editor-shell__body
 {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-height: 0;
}

.editor-shell__body--split
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1rem;
    align-items: stretch;
}

@media (width <= 768px)
 {
    .editor-shell__body--split
 {
        grid-template-columns: minmax(0, 1fr);
    }
}

</style>
