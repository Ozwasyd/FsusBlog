<template>
    <div
        class="article-write-editor"
        data-article-document-editor="true"
        @focusin.capture="$emit('editor-focus', 'focusin')"
        @focusout.capture="$emit('editor-focus', 'focusout')"
    >
        <ArticleWriteOutlineRail
            :active-heading-id="activeHeadingId"
            :snapshot="outline.snapshot.value"
            @reveal-heading="handleOutlineReveal"
            @reveal-range="handleOutlineDiagnosticReveal"
        />

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
            :authoring-surface="activeSurface"
            :source-compare-open="sourceCompareOpen"
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
            @selection-change="handleSelectionChange"
            @transaction="handleTransaction"
            @viewport-change="handleViewportChange"
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
                    :aria-pressed="sessionSurface === 'live'"
                    :disabled="loading"
                    data-authoring-surface="live"
                    @click="requestSurface('live')"
                >
                    实时
                </button>
                <button
                    type="button"
                    :aria-pressed="sessionSurface === 'source'"
                    :disabled="loading"
                    data-authoring-surface="source"
                    @click="requestSurface('source')"
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
            <slot name="secondary-action" />
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import ArticleWriteOutlineRail from '@/components/admin/article/ArticleWriteOutlineRail.vue';
import MarkdownEditorAdapter from '@/components/ui/MarkdownEditorAdapter.vue';
import {
    useArticleOutline,
    type ArticleOutlineSelection
} from '@/composables/useArticleOutline';
import type {
    FsusUiAuthoringCommand,
    FsusUiAuthoringDocumentIdentity,
    FsusUiAuthoringSurfaceOptions
} from '@/fsusui/authoringCommands';
import type { ArticleDocumentContext } from '@/services/authoring/articleDocumentContext';
import type { ArticleEditorContinuityPort } from '@/services/authoring/articleEditorContinuity';
import {
    createArticleEditorSurfacePreference, validateArticleEditorSurfacePreference,
    type ArticleEditorSurface, type ArticleEditorSurfacePreference
} from '@/services/authoring/articleEditorSurface';

import type {
    MarkdownEditorOutlineItem,
    MarkdownEditorOutlineRange,
    MarkdownEditorRevealOptions,
    MarkdownEditorRevealResult,
    MarkdownEditorSelectionEvent as FsusUiMarkdownEditorSelectionEvent,
    MarkdownEditorTransactionEvent
} from '@ozwasyd/element-plus';

defineOptions({ name: 'ArticleWriteEditor' });

type EditorLayoutMode = 'standard' | 'focus' | 'fullscreen';
type ArticleAuthoringSelectionEvent = FsusUiMarkdownEditorSelectionEvent & Readonly<{
    documentIdentity?: FsusUiAuthoringDocumentIdentity;
}>;

const props = withDefaults(defineProps<{
    modelValue: string;
    loading?: boolean;
    saving?: boolean;
    layoutMode?: EditorLayoutMode;
    authoringCommands?: readonly FsusUiAuthoringCommand[];
    commandSurfaces?: FsusUiAuthoringSurfaceOptions;
    documentIdentity?: FsusUiAuthoringDocumentIdentity;
    articleIdentity?: string;
    surfacePreference?: ArticleEditorSurfacePreference | null;
    documentContext?: ArticleDocumentContext | null;
}>(), {
    layoutMode: 'standard',
    authoringCommands: () => [],
    commandSurfaces: () => ({
        toolbar: true,
        selectionToolbar: true,
        slashMenu: true,
        commandPalette: true
    }),
    documentIdentity: undefined,
    articleIdentity: undefined,
    surfacePreference: null,
    documentContext: null
});

const emit = defineEmits<{
    (e: 'update:modelValue', value: string): void;
    (e: 'save'): void;
    (e: 'draft-save'): void;
    (e: 'submit'): void;
    (e: 'transaction', event: MarkdownEditorTransactionEvent): void;
    (e: 'selection-change', event: ArticleAuthoringSelectionEvent): void;
    (e: 'editor-focus', event: 'focusin' | 'focusout'): void;
    (e: 'surface-request', surface: ArticleEditorSurface): void;
    (e: 'upload-img', files: File[], callback: (urls: string[]) => void, onError: (message: string) => void): void;
}>();

const content = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value)
});

const adapterRef = ref<{
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
// Until the canonical preference owner supplies a real snapshot, this is a session choice only.
const sessionSurface = ref<ArticleEditorSurface>('source');
const ownedSurfacePreference = computed(() =>
{
    const preference = props.surfacePreference;
    const context = props.documentContext;
    return context && validateArticleEditorSurfacePreference(preference)
        && preference.siteScope === context.siteScope && preference.userScope === context.userScope
        ? createArticleEditorSurfacePreference(context, preference.surface) : null;
});
watch([
    () => ownedSurfacePreference.value?.contentDigest ?? null,
    () => props.documentContext?.siteScope,
    () => props.documentContext?.userScope
], () =>
{
    // Source revisions do not overwrite a session Source escape; owner/scope changes do.
    sessionSurface.value = ownedSurfacePreference.value?.surface ?? 'source';
}, { immediate: true });
const sourceCompareOpen = ref(false);
const sourceRevision = ref(0);
const selection = ref<ArticleOutlineSelection>({
    start: content.value.length,
    end: content.value.length,
    direction: 'none'
});
const viewport = ref<{ start: number; end: number; } | undefined>();
const activeCause = ref<'caret' | 'selection' | 'manual-scroll' | 'typing'>('caret');

const resolvedArticleIdentity = computed(() => (
    props.articleIdentity ?? props.documentIdentity?.id ?? 'article:new'
));

const outline = useArticleOutline({
    articleIdentity: resolvedArticleIdentity,
    documentIdentity: () => props.documentIdentity,
    source: content,
    sourceRevision,
    selection,
    viewport,
    cause: activeCause
});
const activeHeadingId = computed(() => outline.active.value?.headingId ?? null);

const activeSurface = computed<ArticleEditorSurface>(() => sessionSurface.value);

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

function requestSurface(surface: ArticleEditorSurface): void
{
    sessionSurface.value = surface;
    sourceCompareOpen.value = false;
    emit('surface-request', surface);
}

function toggleSourceCompare(): void
{
    sourceCompareOpen.value = !sourceCompareOpen.value;
}

function currentRevealOptions(): MarkdownEditorRevealOptions | undefined
{
    const identity = props.documentIdentity;
    if (!identity)
    {
        return undefined;
    }
    return {
        expected: {
            documentIdentity: identity,
            revision: sourceRevision.value
        },
        mode: activeSurface.value
    };
}

function handleSelectionChange(event: ArticleAuthoringSelectionEvent): void
{
    const identity = props.documentIdentity;
    if (identity &&
        (identity.id !== event.documentIdentity?.id ||
            identity.epoch !== event.documentIdentity?.epoch))
    {
        return;
    }
    if (event.revision < sourceRevision.value)
    {
        return;
    }
    activeCause.value = 'selection';
    sourceRevision.value = event.revision;
    selection.value = event.selection;
    emit('selection-change', event);
}

function handleTransaction(event: MarkdownEditorTransactionEvent): void
{
    const identity = props.documentIdentity;
    if (!event.accepted ||
        (identity && (identity.id !== event.documentIdentity.id || identity.epoch !== event.documentIdentity.epoch)))
    {
        return;
    }
    if (event.revision < sourceRevision.value)
    {
        return;
    }
    activeCause.value = event.transaction.origin === 'input' ? 'typing' : 'caret';
    sourceRevision.value = event.revision;
    selection.value = event.selection;
    emit('transaction', event);
}

function handleViewportChange(event: {
    documentIdentity: FsusUiAuthoringDocumentIdentity;
    revision: number;
    viewport: { start: number; end: number; };
    cause: 'manual-scroll';
}): void
{
    const identity = props.documentIdentity;
    if (identity?.id !== event.documentIdentity.id || identity?.epoch !== event.documentIdentity.epoch ||
        event.revision < sourceRevision.value)
    {
        return;
    }
    sourceRevision.value = event.revision;
    viewport.value = event.viewport;
    activeCause.value = event.cause;
}

function handleOutlineReveal(item: MarkdownEditorOutlineItem): void
{
    const result = adapterRef.value?.revealHeading?.(item.nodeId, currentRevealOptions());
    if (result === 'success')
    {
        outline.noteOutlineNavigation(item.nodeId);
    }
}

function handleOutlineDiagnosticReveal(item: MarkdownEditorOutlineItem): void
{
    const result = adapterRef.value?.revealSourceRange?.(item.sourceRange, currentRevealOptions());
    if (result === 'success')
    {
        outline.noteOutlineNavigation(item.nodeId);
    }
}

watch(() =>
{
    const identity = props.documentIdentity;
    return `${resolvedArticleIdentity.value}\u0000${identity
        ? `${identity.id}\u0000${String(identity.epoch)}`
        : ''}`;
}, (next, previous) =>
{
    if (next === previous)
    {
        return;
    }
    sourceRevision.value = 0;
    selection.value = {
        start: content.value.length,
        end: content.value.length,
        direction: 'none'
    };
    viewport.value = undefined;
    activeCause.value = 'caret';
});

function insertMarkdownAtCursor(markdown: string): boolean
{
    return adapterRef.value?.insertMarkdownAtCursor?.(markdown) === true;
}

function openCommandPalette(): void
{
    adapterRef.value?.openCommandPalette?.();
}

function closeCommandPalette(): void
{
    adapterRef.value?.closeCommandPalette?.();
}

function getAuthoringEditorPort(): ArticleEditorContinuityPort | null
{
    return adapterRef.value?.getAuthoringEditorPort?.() ?? null;
}

defineExpose({
    getAuthoringEditorPort,
    insertMarkdownAtCursor,
    openCommandPalette,
    closeCommandPalette,
    revealHeading: (nodeId: string, options?: MarkdownEditorRevealOptions) =>
        adapterRef.value?.revealHeading?.(nodeId, options) ?? 'not-found',
    revealSourceRange: (range: MarkdownEditorOutlineRange, options?: MarkdownEditorRevealOptions) =>
        adapterRef.value?.revealSourceRange?.(range, options) ?? 'not-found'
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
