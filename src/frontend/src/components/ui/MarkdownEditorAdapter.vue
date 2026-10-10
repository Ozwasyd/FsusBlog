<template>
    <div
        class="editor-shell-minimal"
        role="region"
        :aria-labelledby="labelledBy"
        :aria-label="labelledBy ? undefined : accessibleName"
        :data-markdown-chrome="chrome"
        :data-status-density="statusDensity"
    >
        <component
            ref="editorRef"
            :is="provider.editorComponent"
            v-model="content"
            :placeholder="placeholder"
            :textarea-id="textareaId"
            :textarea-name="textareaName"
            :mode="resolvedMode"
            :chrome="chrome"
            :status-density="statusDensity"
            :show-mode-switcher="showModeSwitcher"
            :toolbar-density="toolbarDensity"
            :loading="loading"
            :saving="saving"
            :class="editorClass"
            :toolbars-exclude="mergedToolbarsExclude"
            :authoring-commands="authoringCommands"
            :command-surfaces="commandSurfaces"
            :document-identity="documentIdentity"
            :native-attachment-input="nativeAttachmentInput"
            @attachment-capture="handleAttachmentCapture"
            @on-save="emit('save')"
            @on-draft-save="emit('draft-save')"
            @on-submit="emit('submit')"
            @on-upload-img="handleUploadImg"
            @selection-change="emit('selection-change', $event)"
            @transaction="emit('transaction', $event)"
            @viewport-change="emit('viewport-change', $event)"
        />
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import { resolveMarkdownEditorProvider } from '@/components/ui/markdownEditorProvider';
import type { MarkdownAttachmentBatchIntent, MarkdownAttachmentCaptureObservation } from '@/fsusui/articleAttachments';
import type {
    FsusUiAuthoringCommand,
    FsusUiAuthoringDocumentIdentity,
    FsusUiAuthoringSurfaceOptions
} from '@/fsusui/authoringCommands';
import type { ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import type { ArticleEditorSurface } from '@/services/authoring/articleEditorSurface';
import type {
    MarkdownEditorChrome,
    MarkdownEditorMode,
    MarkdownEditorStatusDensity
} from '@/ui-contracts/markdownEditor';

import type {
    MarkdownEditorOutlineRange,
    MarkdownEditorRevealOptions,
    MarkdownEditorRevealResult,
    MarkdownEditorSelectionEvent as FsusUiMarkdownEditorSelectionEvent,
    MarkdownEditorTransactionEvent
} from '@ozwasyd/element-plus';

type ArticleAuthoringSelectionEvent = FsusUiMarkdownEditorSelectionEvent & Readonly<{
    documentIdentity?: FsusUiAuthoringDocumentIdentity;
}>;

defineOptions({ name: 'MarkdownEditorAdapter' });

const props = withDefaults(defineProps<{
    modelValue: string;
    placeholder?: string;
    textareaId?: string;
    textareaName?: string;
    editorClass?: string;
    labelledBy?: string;
    accessibleName?: string;
    toolbarsExclude?: string[];
    loading?: boolean;
    saving?: boolean;
    mode?: MarkdownEditorMode;
    authoringSurface?: ArticleEditorSurface;
    sourceCompareOpen?: boolean;
    chrome?: MarkdownEditorChrome;
    statusDensity?: MarkdownEditorStatusDensity;
    showModeSwitcher?: boolean;
    nativeAttachmentInput?: boolean;
    toolbarDensity?: 'minimal' | 'standard' | 'full';
    authoringCommands?: readonly FsusUiAuthoringCommand[];
    commandSurfaces?: FsusUiAuthoringSurfaceOptions;
    documentIdentity?: FsusUiAuthoringDocumentIdentity;
}>(), {
    placeholder: '',
    textareaId: undefined,
    textareaName: 'markdownContent',
    editorClass: '',
    labelledBy: undefined,
    accessibleName: '正文',
    loading: false,
    saving: false,
    mode: 'source',
    authoringSurface: undefined,
    sourceCompareOpen: false,
    chrome: 'framed',
    statusDensity: 'minimal',
    showModeSwitcher: true,
    nativeAttachmentInput: false,
    toolbarDensity: 'standard',
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
    (e: 'attachment-capture', batch: MarkdownAttachmentBatchIntent, capture: MarkdownAttachmentCaptureObservation | undefined): void;
    (e: 'selection-change', event: ArticleAuthoringSelectionEvent): void;
    (e: 'transaction', event: MarkdownEditorTransactionEvent): void;
    (e: 'viewport-change', event: {
        documentIdentity: FsusUiAuthoringDocumentIdentity;
        revision: number;
        viewport: { start: number; end: number; };
        cause: 'manual-scroll';
    }): void;
}>();

const provider = computed(() => resolveMarkdownEditorProvider());
const editorRef = ref<{
    getAuthoringEditorPort?: () => ArticleEditorContinuityPort | null;
    insertMarkdownAtCursor?: (markdown: string) => boolean;
    openCommandPalette?: () => void;
    closeCommandPalette?: () => void;
    revealHeading?: (
        nodeId: string,
        options?: MarkdownEditorRevealOptions
    ) => MarkdownEditorRevealResult;
    revealSourceRange?: (
        range: MarkdownEditorOutlineRange,
        options?: MarkdownEditorRevealOptions
    ) => MarkdownEditorRevealResult;
} | null>(null);

const content = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value)
});

// Product surfaces remain closed; the temporary compare tool maps at this native adapter boundary.
const resolvedMode = computed<MarkdownEditorMode>(() => props.authoringSurface === undefined
    ? props.mode : props.sourceCompareOpen ? 'split' : props.authoringSurface);
const mergedToolbarsExclude = computed(() =>
{
    return Array.from(new Set([...(props.toolbarsExclude ?? []), ...provider.value.defaultToolbarsExclude]));
});

const handleUploadImg = (files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void =>
{
    emit('upload-img', files, callback, onError);
};

function handleAttachmentCapture(batch: MarkdownAttachmentBatchIntent, capture?: MarkdownAttachmentCaptureObservation): void
{
    emit('attachment-capture', batch, capture);
}

function insertMarkdownAtCursor(markdown: string): boolean
{
    return editorRef.value?.insertMarkdownAtCursor?.(markdown) === true;
}

function openCommandPalette(): void
{
    editorRef.value?.openCommandPalette?.();
}

function closeCommandPalette(): void
{
    editorRef.value?.closeCommandPalette?.();
}

function revealHeading(
    nodeId: string,
    options?: MarkdownEditorRevealOptions
): MarkdownEditorRevealResult
{
    return editorRef.value?.revealHeading?.(nodeId, nativeRevealOptions(options)) ?? 'not-found';
}

function revealSourceRange(
    range: MarkdownEditorOutlineRange,
    options?: MarkdownEditorRevealOptions
): MarkdownEditorRevealResult
{
    return editorRef.value?.revealSourceRange?.(range, nativeRevealOptions(options)) ?? 'not-found';
}

function nativeRevealOptions(options?: MarkdownEditorRevealOptions): MarkdownEditorRevealOptions | undefined
{
    return options && props.authoringSurface !== undefined ? { ...options, mode: resolvedMode.value } : options;
}

function getAuthoringEditorPort(): ArticleEditorContinuityPort | null
{
    return editorRef.value?.getAuthoringEditorPort?.() ?? null;
}

defineExpose({
    getAuthoringEditorPort,
    insertMarkdownAtCursor,
    openCommandPalette,
    closeCommandPalette,
    revealHeading,
    revealSourceRange
});
</script>

<style scoped>
.editor-shell-minimal
 {
    display: flex;
    flex-direction: column;
    width: 100%;
    align-self: stretch;
    min-width: 0;
}
</style>
