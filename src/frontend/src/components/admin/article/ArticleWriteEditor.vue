<template>
    <div
        class="article-write-editor"
        data-article-document-editor="true"
    >
        <MarkdownEditorAdapter
            ref="adapterRef"
            v-model="content"
            textarea-id="article-content"
            textarea-name="articleContent"
            labelled-by="article-body-heading"
            accessible-name="正文"
            placeholder="从这里开始写正文。"
            chrome="embedded"
            status-density="minimal"
            toolbar-density="standard"
            :show-mode-switcher="false"
            :mode="activeSurface"
            :editor-class="editorSizingClass"
            :toolbars-exclude="['save']"
            :loading="loading"
            :saving="saving"
            :authoring-commands="authoringCommands"
            :command-surfaces="commandSurfaces"
            :document-identity="documentIdentity"
            @save="$emit('draft-save')"
            @draft-save="$emit('draft-save')"
            @submit="$emit('submit')"
            @upload-img="handleUploadImg"
        />

        <div
            class="article-write-editor__secondary"
            role="group"
            aria-label="编辑表面与对照工具"
        >
            <div
                class="article-write-editor__surface-menu"
                role="group"
                aria-label="编辑表面"
            >
                <button
                    type="button"
                    :aria-pressed="persistedSurface === 'live'"
                    :disabled="loading"
                    data-authoring-surface="live"
                    @click="setPersistedSurface('live')"
                >
                    实时
                </button>
                <button
                    type="button"
                    :aria-pressed="persistedSurface === 'source'"
                    :disabled="loading"
                    data-authoring-surface="source"
                    @click="setPersistedSurface('source')"
                >
                    源码
                </button>
            </div>
            <button
                type="button"
                :aria-pressed="sourceCompareOpen"
                :disabled="loading"
                data-authoring-tool="source-compare"
                @click="toggleSourceCompare"
            >
                源码对照
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import MarkdownEditorAdapter from '@/components/ui/MarkdownEditorAdapter.vue';
import type {
    FsusUiAuthoringCommand,
    FsusUiAuthoringDocumentIdentity,
    FsusUiAuthoringSurfaceOptions
} from '@/fsusui/authoringCommands';
import type { MarkdownEditorMode } from '@/ui-contracts/markdownEditor';

defineOptions({ name: 'ArticleWriteEditor' });

type EditorLayoutMode = 'standard' | 'focus' | 'fullscreen';
type PersistedAuthoringSurface = Extract<MarkdownEditorMode, 'live' | 'source'>;

const props = withDefaults(defineProps<{
    modelValue: string;
    loading?: boolean;
    saving?: boolean;
    layoutMode?: EditorLayoutMode;
    authoringCommands?: readonly FsusUiAuthoringCommand[];
    commandSurfaces?: FsusUiAuthoringSurfaceOptions;
    documentIdentity?: FsusUiAuthoringDocumentIdentity;
}>(), {
    layoutMode: 'standard',
    authoringCommands: () => [],
    commandSurfaces: () => ({
        toolbar: true,
        selectionToolbar: true,
        slashMenu: true,
        commandPalette: true
    }),
    documentIdentity: undefined
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'save'): void;
    (e: 'draft-save'): void;
    (e: 'submit'): void;
    (e: 'upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void;
}>();

const adapterRef = ref<{
    insertMarkdownAtCursor?: (markdown: string) => boolean;
    openCommandPalette?: () => void;
} | null>(null);
const persistedSurface = ref<PersistedAuthoringSurface>('source');
const sourceCompareOpen = ref(false);

const content = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value)
});

const activeSurface = computed<MarkdownEditorMode>(() => (
    sourceCompareOpen.value ? 'split' : persistedSurface.value
));

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

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void =>
{
    emit('upload-img', files, callback, onError);
};

function setPersistedSurface(surface: PersistedAuthoringSurface): void
{
    persistedSurface.value = surface;
    sourceCompareOpen.value = false;
}

function toggleSourceCompare(): void
{
    sourceCompareOpen.value = !sourceCompareOpen.value;
}

function insertMarkdownAtCursor(markdown: string): boolean
{
    return adapterRef.value?.insertMarkdownAtCursor?.(markdown) === true;
}

function openCommandPalette(): void
{
    adapterRef.value?.openCommandPalette?.();
}

defineExpose({
    insertMarkdownAtCursor,
    openCommandPalette
});
</script>

<style scoped>
.article-write-editor
 {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
}

.article-write-editor__secondary,
.article-write-editor__surface-menu
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
}

.article-write-editor__secondary
 {
    margin-top: 0.75rem;
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    line-height: 1.4;
}

.article-write-editor__secondary button
 {
    min-height: 2.75rem;
    padding-inline: 0.5rem;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
}

.article-write-editor__secondary button[aria-pressed='true']
 {
    color: var(--fsusblog-text-primary);
    font-weight: 700;
}

.article-write-editor__secondary button:disabled
 {
    cursor: not-allowed;
    opacity: 0.6;
}
</style>
