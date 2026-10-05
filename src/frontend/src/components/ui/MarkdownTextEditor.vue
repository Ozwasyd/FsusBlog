<template>
    <div
        ref="rootRef"
        class="markdown-text-editor"
        @click.capture="rememberTextareaSelectionFromEvent"
        @focusin.capture="rememberTextareaSelectionFromEvent"
        @keyup.capture="rememberTextareaSelectionFromEvent"
        @select.capture="rememberTextareaSelectionFromEvent"
        @keydown.capture="handleKeydown"
        @pointerdown.capture="cancelProgrammaticViewportSuppression"
        @paste.capture="handlePaste"
        @wheel.capture="cancelProgrammaticViewportSuppression"
        @scroll.capture="trackAuthoringViewport"
    >
        <ElMarkdownEditor
            ref="editorRef"
            v-model="localValue"
            class="markdown-text-editor__fsusui"
            :action-overflow-keys="actionOverflowKeys"
            :chrome="chrome"
            :commands="fsusUiCommands"
            :command-overflow-label="commandOverflowLabel"
            :default-mode="fsusUiMode"
            :disabled="editorDisabled"
            :document-identity="documentIdentity"
            editor-profile="prose"
            image-action-label="上传图片"
            interaction-profile="auto"
            :loading="loading"
            :locale-text="articleBodyLocaleText"
            mobile-layout="auto"
            :mode="fsusUiMode"
            :placeholder="placeholder"
            :primary-command-keys="articleBodyPrimaryCommandKeys"
            :show-actions="showImageAction || showSaveAction"
            :show-image-action="showImageAction"
            :show-mode-switcher="showModeSwitcher"
            :show-save-action="showSaveAction"
            :show-submit-action="false"
            :status-density="statusDensity"
            :surfaces="articleBodyCommandSurfaces"
            :textarea-id="textareaId"
            :textarea-name="textareaName"
            toolbar-density="standard"
            :writing-placeholder="writingPlaceholder"
            @selection-change="trackAuthoringSelection"
            @save="emitSave"
            @submit="emitSubmit"
            @transaction="trackAuthoringTransaction"
            @upload-image="requestImageUpload"
        />
        <p
            v-if="headingDiagnosticText"
            class="markdown-text-editor__heading-diagnostic"
            role="status"
            aria-live="polite"
        >
            {{ headingDiagnosticText }}
        </p>
        <p
            v-if="uploadError"
            class="markdown-text-editor__upload-error"
            role="alert"
        >
            {{ uploadError }}
        </p>

        <input
            ref="imageInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            aria-hidden="true"
            tabindex="-1"
            @change="handleImagePick"
        />
    </div>
</template>

<script setup lang="ts">
import {
    ElMarkdownEditor,
    defaultMarkdownEditorCommands,
    type MarkdownEditorCommand as FsusUiMarkdownEditorCommand,
    type MarkdownEditorCommandContext as FsusUiMarkdownEditorCommandContext,
    type MarkdownEditorMode as FsusUiMarkdownEditorMode,
    type MarkdownEditorOutlineRange,
    type MarkdownEditorRevealOptions,
    type MarkdownEditorRevealResult,
    type MarkdownEditorSelectionEvent as FsusUiMarkdownEditorSelectionEvent,
    type MarkdownEditorTransactionEvent as FsusUiMarkdownEditorTransactionEvent
} from '@ozwasyd/element-plus';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import {
    articleBodyCommandOverflowLabel,
    articleBodyCommandSurfaces,
    articleBodyLocaleText,
    articleBodyPrimaryCommandKeys,
    composeArticleBodyEditorCommands
} from '@/components/ui/markdown-editor/articleBodyCommandConfig';
import {
    diagnoseArticleBodyH1,
    formatArticleBodyH1Diagnostic
} from '@/components/ui/markdown-editor/articleBodyHeadingDiagnostics';
import {
    executeMarkdownEditorCommand,
    markdownEditorCommands
} from '@/components/ui/markdown-editor/commands';
import { createSnapshot, replaceSelection, type SelectionResult, type SelectionSnapshot } from '@/components/ui/markdown-editor/selection';
import {
    mergeFsusUiAuthoringCommands,
    type FsusUiAuthoringCommand,
    type FsusUiAuthoringDocumentIdentity,
    type FsusUiAuthoringSurfaceOptions
} from '@/fsusui/authoringCommands';
import { createMarkdownSourceCoordinateMap } from '@/fsusui/markdownOutline';
import type {
    MarkdownEditorChrome,
    MarkdownEditorCommand,
    MarkdownEditorCommandKey,
    MarkdownEditorMode,
    MarkdownEditorStatusDensity
} from '@/ui-contracts/markdownEditor';

type FsusUiMarkdownEditorExpose = Readonly<{
    insertMarkdownAtCursor?: (markdown: string) => boolean;
    openCommandPalette?: () => void;
    revealHeading?: (
        nodeId: string,
        options?: MarkdownEditorRevealOptions
    ) => MarkdownEditorRevealResult;
    revealSourceRange?: (
        range: MarkdownEditorOutlineRange,
        options?: MarkdownEditorRevealOptions
    ) => MarkdownEditorRevealResult;
}>;

type AuthoringDocumentBinding = Readonly<{
    documentEpoch: number;
    documentId: string;
    revision: number;
    selectionDirection: 'backward' | 'forward' | 'none';
    selectionEnd: number;
    selectionStart: number;
}>;

type ArticleAuthoringSelectionEvent = FsusUiMarkdownEditorSelectionEvent & Readonly<{
    documentIdentity?: FsusUiAuthoringDocumentIdentity;
}>;

type BlogCommandKey = Exclude<MarkdownEditorCommandKey, 'undo' | 'redo' | 'image' | 'save' | 'bold' | 'italic' | 'quote' | 'link' | 'code'>;

const props = withDefaults(defineProps<{
    modelValue: string;
    placeholder?: string;
    textareaId?: string;
    textareaName?: string;
    mode?: MarkdownEditorMode;
    chrome?: MarkdownEditorChrome;
    statusDensity?: MarkdownEditorStatusDensity;
    showModeSwitcher?: boolean;
    toolbarDensity?: 'minimal' | 'standard' | 'full';
    toolbarsExclude?: string[];
    saving?: boolean;
    loading?: boolean;
    authoringCommands?: readonly FsusUiAuthoringCommand[];
    documentIdentity?: FsusUiAuthoringDocumentIdentity;
    commandSurfaces?: FsusUiAuthoringSurfaceOptions;
}>(), {
    placeholder: '',
    textareaId: undefined,
    textareaName: 'markdownContent',
    mode: 'source',
    chrome: 'framed',
    statusDensity: 'minimal',
    showModeSwitcher: true,
    toolbarDensity: 'standard',
    toolbarsExclude: () => [],
    saving: false,
    loading: false,
    authoringCommands: () => [],
    documentIdentity: undefined,
    commandSurfaces: () => articleBodyCommandSurfaces
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'on-save'): void;
    (e: 'on-draft-save'): void;
    (e: 'on-submit'): void;
    (e: 'on-upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void;
    (e: 'selection-change', event: ArticleAuthoringSelectionEvent): void;
    (e: 'transaction', event: FsusUiMarkdownEditorTransactionEvent): void;
    (e: 'viewport-change', event: {
        documentIdentity: FsusUiAuthoringDocumentIdentity;
        revision: number;
        viewport: { start: number; end: number; };
        cause: 'manual-scroll';
    }): void;
}>();

const rootRef = ref<HTMLElement | null>(null);
const editorRef = ref<FsusUiMarkdownEditorExpose | null>(null);
const currentAuthoringBinding = ref<AuthoringDocumentBinding | null>(null);
const imageInputRef = ref<HTMLInputElement | null>(null);
const isUploading = ref(false);
const uploadError = ref('');
const lastSelection = ref<SelectionSnapshot | null>(null);
const cursorState = ref({ line: 1, column: 1 });
let coordinateMapSource = '';
let coordinateMap: ReturnType<typeof createMarkdownSourceCoordinateMap> | null = null;
const programmaticViewportSuppressionMs = 1000;
let suppressProgrammaticViewportUntil = 0;
let programmaticViewportSuppressionTimer: ReturnType<typeof setTimeout> | undefined;

const actionOverflowKeys = ['image'] as const;

const localValue = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value)
});

const editorDisabled = computed(() => props.saving || props.loading);
const commandOverflowLabel = computed(() => props.authoringCommands.length > 0 ? '更多命令' : articleBodyCommandOverflowLabel);
const excludedToolbarKeys = computed(() => new Set(props.toolbarsExclude));
const showImageAction = computed(() => !excludedToolbarKeys.value.has('image'));
const showSaveAction = computed(() => !excludedToolbarKeys.value.has('save'));
const fsusUiMode = computed<FsusUiMarkdownEditorMode>(() =>
{
    if (props.mode === 'live' || props.mode === 'split' || props.mode === 'preview')
    {
        return props.mode;
    }

    return 'source';
});
const writingPlaceholder = computed(() => props.placeholder || '从这里开始写正文。');
const headingIssues = computed(() => diagnoseArticleBodyH1(localValue.value));
const headingDiagnosticText = computed(() => formatArticleBodyH1Diagnostic(headingIssues.value));
const fsusUiCommands = computed<readonly FsusUiAuthoringCommand[]>(() =>
    mergeFsusUiAuthoringCommands(composeArticleBodyEditorCommands(
        defaultMarkdownEditorCommands,
        markdownEditorCommands.map(toFsusUiCommand),
        [...excludedToolbarKeys.value]
    ), props.authoringCommands.map(withExactAuthoringBinding)));

function bindingFromContext(context: FsusUiMarkdownEditorCommandContext): AuthoringDocumentBinding
{
    return Object.freeze({
        documentEpoch: context.documentIdentity.epoch,
        documentId: context.documentIdentity.id,
        revision: context.revision,
        selectionDirection: context.selection.direction ?? 'none',
        selectionEnd: context.selection.end,
        selectionStart: context.selection.start
    });
}

function isCurrentAuthoringBinding(expected: AuthoringDocumentBinding): boolean
{
    const current = currentAuthoringBinding.value;
    const identity = props.documentIdentity;
    return current !== null &&
        current.documentEpoch === expected.documentEpoch &&
        current.documentId === expected.documentId &&
        current.revision === expected.revision &&
        current.selectionDirection === expected.selectionDirection &&
        current.selectionEnd === expected.selectionEnd &&
        current.selectionStart === expected.selectionStart &&
        (identity === undefined ||
            (identity.epoch === expected.documentEpoch && identity.id === expected.documentId));
}

function withExactAuthoringBinding(command: FsusUiAuthoringCommand): FsusUiAuthoringCommand
{
    return Object.freeze({
        ...command,
        run: async (context: FsusUiMarkdownEditorCommandContext) =>
        {
            const expected = bindingFromContext(context);
            currentAuthoringBinding.value = expected;
            return await command.run({
                ...context,
                dispatch: {
                    dispatch: (transaction) =>
                    {
                        if (!isCurrentAuthoringBinding(expected))
                        {
                            throw new Error('Authoring command selection or document binding is stale.');
                        }
                        return context.dispatch.dispatch(transaction);
                    }
                }
            });
        }
    });
}

function toFsusUiCommand(command: MarkdownEditorCommand): FsusUiMarkdownEditorCommand
{
    return {
        key: command.key,
        label: command.label,
        description: command.ariaLabel,
        group: command.group,
        shortcut: normalizeShortcut(command.shortcut),
        title: command.label,
        run: (context: {
            selection: { start: number; end: number; direction?: 'forward' | 'backward' | 'none'; };
            value: string;
        }) =>
        {
            const selection = context.selection;
            const result = executeMarkdownEditorCommand(command.key as BlogCommandKey, {
                snapshot: createSnapshot(context.value, selection.start, selection.end)
            });
            // Blog command handlers rewrite only the selected range (same
            // replaceSelection model as FsusUI's replaceRange), so the resulting
            // snippet is the changed region: old value inserted at [start, end)
            // is replaced by the same slice from the new value.
            const oldValue = context.value;
            const insertedLength = result.value.length - oldValue.length + (selection.end - selection.start);
            return {
                transaction: {
                    changes: [{
                        from: selection.start,
                        insert: result.value.slice(selection.start, selection.start + insertedLength),
                        to: selection.end
                    }],
                    history: 'separate',
                    origin: 'command',
                    selection: {
                        direction: result.start === result.end ? 'none' : selection.direction,
                        start: result.start,
                        end: result.end
                    }
                }
            };
        }
    };
}

function normalizeShortcut(shortcut?: string): string | undefined
{
    if (!shortcut)
    {
        return undefined;
    }

    return shortcut.replace(/^Ctrl\+/u, 'Mod+');
}

function cursorFromIndex(value: string, index: number): { line: number; column: number; }
{
    const safeIndex = Math.max(0, Math.min(index, value.length));
    const before = value.slice(0, safeIndex);
    const lines = before.split('\n');
    return {
        line: lines.length,
        column: lines[lines.length - 1].length + 1
    };
}

function textareaFromEvent(event: Event): HTMLTextAreaElement | null
{
    const target = event.target;
    return target instanceof HTMLTextAreaElement ? target : null;
}

function snapshotFromTextarea(textarea: HTMLTextAreaElement): SelectionSnapshot
{
    return createSnapshot(localValue.value, textarea.selectionStart, textarea.selectionEnd);
}

function rememberTextareaSelection(textarea: HTMLTextAreaElement): void
{
    const snapshot = snapshotFromTextarea(textarea);
    lastSelection.value = snapshot;
    cursorState.value = cursorFromIndex(snapshot.value, snapshot.start);
}

function rememberTextareaSelectionFromEvent(event: Event): void
{
    const textarea = textareaFromEvent(event);
    if (textarea)
    {
        rememberTextareaSelection(textarea);
    }
}

async function applyResult(result: SelectionResult): Promise<void>
{
    localValue.value = result.value;
    await nextTick();
    const textarea = rootRef.value?.querySelector('textarea');
    textarea?.focus();
    textarea?.setSelectionRange(result.start, result.end);
    if (textarea)
    {
        rememberTextareaSelection(textarea);
    }
}

async function insertMarkdownFromSnapshot(markdown: string, snapshot: SelectionSnapshot): Promise<void>
{
    await applyResult(replaceSelection(snapshot, markdown));
}

function insertMarkdownAtCursor(markdown: string): boolean
{
    return editorRef.value?.insertMarkdownAtCursor?.(markdown) === true;
}

function openCommandPalette(): void
{
    editorRef.value?.openCommandPalette?.();
}

function revealHeading(
    nodeId: string,
    options?: MarkdownEditorRevealOptions
): MarkdownEditorRevealResult
{
    const result = editorRef.value?.revealHeading?.(nodeId, options) ?? 'not-found';
    if (result === 'success')
    {
        armProgrammaticViewportSuppression();
    }
    return result;
}

function revealSourceRange(
    range: MarkdownEditorOutlineRange,
    options?: MarkdownEditorRevealOptions
): MarkdownEditorRevealResult
{
    const result = editorRef.value?.revealSourceRange?.(range, options) ?? 'not-found';
    if (result === 'success')
    {
        armProgrammaticViewportSuppression();
    }
    return result;
}

function armProgrammaticViewportSuppression(): void
{
    if (programmaticViewportSuppressionTimer !== undefined)
    {
        clearTimeout(programmaticViewportSuppressionTimer);
    }
    suppressProgrammaticViewportUntil = Date.now() + programmaticViewportSuppressionMs;
    programmaticViewportSuppressionTimer = setTimeout(() =>
    {
        suppressProgrammaticViewportUntil = 0;
        programmaticViewportSuppressionTimer = undefined;
    }, programmaticViewportSuppressionMs);
}

function cancelProgrammaticViewportSuppression(): void
{
    if (programmaticViewportSuppressionTimer !== undefined)
    {
        clearTimeout(programmaticViewportSuppressionTimer);
        programmaticViewportSuppressionTimer = undefined;
    }
    suppressProgrammaticViewportUntil = 0;
}

onBeforeUnmount(cancelProgrammaticViewportSuppression);

function trackAuthoringSelection(event: FsusUiMarkdownEditorSelectionEvent): void
{
    const identity = props.documentIdentity;
    emit('selection-change', identity ? { ...event, documentIdentity: identity } : event);
    if (identity === undefined)
    {
        currentAuthoringBinding.value = null;
        return;
    }
    currentAuthoringBinding.value = Object.freeze({
        documentEpoch: identity.epoch,
        documentId: identity.id,
        revision: event.revision,
        selectionDirection: event.selection.direction ?? 'none',
        selectionEnd: event.selection.end,
        selectionStart: event.selection.start
    });
}

function trackAuthoringTransaction(event: FsusUiMarkdownEditorTransactionEvent): void
{
    emit('transaction', event);
    if (!event.accepted)
    {
        return;
    }
    currentAuthoringBinding.value = Object.freeze({
        documentEpoch: event.documentIdentity.epoch,
        documentId: event.documentIdentity.id,
        revision: event.revision,
        selectionDirection: event.selection.direction ?? 'none',
        selectionEnd: event.selection.end,
        selectionStart: event.selection.start
    });
}

function trackAuthoringViewport(event: Event): void
{
    const identity = props.documentIdentity;
    const textarea = textareaFromEvent(event);
    if (!identity || !textarea || textarea.hidden)
    {
        return;
    }

    if (suppressProgrammaticViewportUntil > Date.now())
    {
        return;
    }

    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0)
    {
        return;
    }

    if (coordinateMapSource !== localValue.value || coordinateMap === null)
    {
        coordinateMapSource = localValue.value;
        coordinateMap = createMarkdownSourceCoordinateMap(localValue.value);
    }

    const firstLine = Math.max(1, Math.floor(textarea.scrollTop / lineHeight) + 1);
    const visibleLines = Math.max(1, Math.ceil(textarea.clientHeight / lineHeight) + 1);
    const lastLine = firstLine + visibleLines;
    let start = 0;
    try
    {
        start = coordinateMap.toRawOffsetFromLineColumn({ line: firstLine, column: 0 });
    }
    catch
    {
        return;
    }
    let end = localValue.value.length;
    try
    {
        end = coordinateMap.toRawOffsetFromLineColumn({ line: lastLine, column: 0 });
    }
    catch
    {
        // The final viewport can extend past the last source line.
    }

    emit('viewport-change', {
        cause: 'manual-scroll',
        documentIdentity: identity,
        revision: currentAuthoringBinding.value?.revision ?? 0,
        viewport: { start, end: Math.max(start, end) }
    });
}

function emitSave(): void
{
    emit('on-draft-save');
    emit('on-save');
}

function emitSubmit(): void
{
    emit('on-submit');
}

function requestImageUpload(): void
{
    imageInputRef.value?.click();
}

async function handleImagePick(event: Event): Promise<void>
{
    const input = event.target as HTMLInputElement | null;
    const files = Array.from(input?.files ?? []);
    if (!files.length)
    {
        return;
    }

    const textarea = rootRef.value?.querySelector('textarea');
    const snapshot = textarea ? snapshotFromTextarea(textarea) : lastSelection.value;
    if (!snapshot)
    {
        return;
    }

    await uploadImages(files, snapshot);

    if (input)
    {
        input.value = '';
    }
}

function handlePaste(event: ClipboardEvent): void
{
    const textarea = textareaFromEvent(event);
    if (!textarea)
    {
        return;
    }

    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
    if (files.length)
    {
        event.preventDefault();
        void uploadImages(files, snapshotFromTextarea(textarea));
        return;
    }

    const text = event.clipboardData?.getData('text/plain');
    if (!text)
    {
        return;
    }

    const url = text.trim();
    if (/^https?:\/\//.test(url))
    {
        uploadError.value = '';
    }
}

function handleKeydown(event: KeyboardEvent): void
{
    const textarea = textareaFromEvent(event);
    if (!textarea)
    {
        return;
    }

    cancelProgrammaticViewportSuppression();

    if (event.key === 'Escape')
    {
        focusNextControl(textarea);
    }
}

function focusNextControl(textarea: HTMLTextAreaElement): void
{
    const focusableSelector = [
        'a[href]',
        'button:not([disabled])',
        'textarea:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => !element.hasAttribute('aria-hidden') && element.offsetParent !== null);
    const currentIndex = focusable.indexOf(textarea);
    focusable[currentIndex + 1]?.focus();
}

function normalizeImageAlt(fileName: string): string
{
    const baseName = fileName
        .replace(/\.[^.]+$/u, '')
        .replace(/\s+/g, ' ')
        .trim();
    return baseName || '图片';
}

function createUploadId(): string
{
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function replaceUploadPlaceholders(placeholders: readonly { token: string; }[], replacements: readonly string[]): void
{
    let nextValue = localValue.value;
    placeholders.forEach((placeholder, index) =>
    {
        nextValue = nextValue.replace(placeholder.token, replacements[index] || '');
    });
    localValue.value = nextValue;
}

async function uploadImages(files: File[], snapshot: SelectionSnapshot): Promise<void>
{
    isUploading.value = true;
    uploadError.value = '';
    const placeholders = files.map((file) =>
    {
        const alt = normalizeImageAlt(file.name);
        const id = createUploadId();
        return {
            id,
            alt,
            token: `![uploading: ${alt}](fsus-upload-placeholder://${id})`
        };
    });

    await insertMarkdownFromSnapshot(placeholders.map((placeholder) => placeholder.token).join('\n'), snapshot);

    emit(
        'on-upload-img',
        files,
        (urls) =>
        {
            try
            {
                const markdown = urls.map((url, index) => `![${placeholders[index]?.alt ?? '图片'}](${url})`);
                replaceUploadPlaceholders(placeholders, markdown);
                uploadError.value = '';
            }
            finally
            {
                isUploading.value = false;
            }
        },
        (message) =>
        {
            const failed = placeholders.map((placeholder) =>
                `![上传失败: ${placeholder.alt}](fsus-upload-placeholder://failed-${placeholder.id})`);
            replaceUploadPlaceholders(placeholders, failed);
            uploadError.value = `${message}，可重新粘贴或点击图片按钮重试`;
            isUploading.value = false;
        }
    );
}

watch(() => props.modelValue, () =>
{
    if (!isUploading.value)
    {
        uploadError.value = '';
    }
});

watch(() => props.documentIdentity, () =>
{
    currentAuthoringBinding.value = null;
});

defineExpose({
    insertMarkdownAtCursor,
    openCommandPalette,
    revealHeading,
    revealSourceRange
});
</script>

<style scoped>
.markdown-text-editor
 {
    width: 100%;
    height: 100%;
    min-width: 0;
}

.markdown-text-editor__fsusui
 {
    width: 100%;
    height: 100%;
    min-height: 0;
}

.markdown-text-editor__upload-error
 {
    margin: 0.5rem 0 0;
    color: var(--fsusblog-color-danger);
    font-size: 12px;
    line-height: 1.5;
}

.markdown-text-editor__heading-diagnostic
 {
    margin: 0.5rem 0 0;
    min-width: 0;
    color: var(--fsusblog-text-primary);
    font-size: 14px;
    font-weight: 500;
    line-height: 1.5;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control-small);
    padding: 0.4rem 0.6rem;
    background: var(--fsusblog-page-bg);
}
</style>
