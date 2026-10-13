<template>
    <section
        class="article-private-preview-panel border-t border-[var(--fsusblog-panel-border)]"
        aria-labelledby="article-private-preview-title"
    >
        <header class="px-4 py-3 bg-[var(--fsusblog-page-bg-soft)] border-b border-[var(--fsusblog-panel-border)]">
            <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                    <div
                        id="article-private-preview-title"
                        class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
                    >私有预览</div>
                    <p
                        class="mt-1 text-xs text-[var(--fsusblog-text-tertiary)]"
                        aria-live="polite"
                    >{{ statusText }}</p>
                </div>
                <ElButton
                    type="primary"
                    :icon="View"
                    :loading="loading"
                    :disabled="loading || !canPreview"
                    aria-label="生成私有预览"
                    @click="$emit('preview')"
                >
                    生成预览
                </ElButton>
            </div>
        </header>

        <div class="space-y-4 p-4 bg-[var(--fsusblog-page-bg)]">
            <div
                v-if="preview?.issues.length"
                class="preview-issues"
                aria-label="预览检查结果"
            >
                <span
                    v-for="issue in preview.issues"
                    :key="`${issue.severity}:${issue.code}`"
                    class="preview-issue"
                    :class="`preview-issue--${issue.severity}`"
                >
                    {{ issue.message }}
                </span>
            </div>

            <article
                v-if="preview"
                class="author-preview"
                data-preview-only="true"
                data-fsus-surface="reading"
                :data-preview-source-identity="preview.sourceIdentity"
                :data-preview-render-complete="previewRenderComplete
                    ? preview.sourceIdentity
                    : undefined"
                :data-preview-render-markdown-identity="renderMarkdownIdentity ?? undefined"
                :data-preview-activation-markdown-identity="activationMarkdownIdentity ?? undefined"
            >
                <h1>{{ preview.normalizedTitle }}</h1>
                <p class="author-preview__summary">{{ preview.normalizedSummary }}</p>
                <figure
                    v-if="coverImageUrl"
                    class="author-preview__cover"
                >
                    <img
                        :src="coverImageUrl"
                        alt=""
                        loading="lazy"
                        decoding="async"
                    >
                </figure>
                <ArticleBodyMarkdownPreview
                    :key="preview.sourceIdentity"
                    :content="preview.normalizedMarkdownSource"
                    :content-version="preview.sourceIdentity"
                    @features-activated="handleFeaturesActivated"
                    @render-complete="handleRenderComplete"
                    @render-error="handleRenderError"
                />
            </article>
            <p
                v-else
                class="preview-empty"
            >暂无预览快照。</p>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import {
    normalizePreviewCoverImageUrl,
    type ArticlePreviewResponse
} from '@/api/authoring';
import ArticleBodyMarkdownPreview from '@/components/admin/article/ArticleBodyMarkdownPreview.vue';
import { View } from '@/fsusui/icons';
import type {
    MarkdownFeatureActivationKind,
    MarkdownFeatureActivationResult,
    MarkdownRenderResult
} from '@/fsusui/markdown';

const props = defineProps<{
    preview: ArticlePreviewResponse | null;
    loading: boolean;
    statusText: string;
    canPreview: boolean;
}>();

defineEmits<(e: 'preview') => void>();

const coverImageUrl = computed(() =>
    normalizePreviewCoverImageUrl(props.preview?.normalizedCoverImageUrl)
);

type MarkdownCompletionObservation = Readonly<{
    previewIdentity: string;
    markdownIdentity: string;
}>;

const renderObservation = ref<MarkdownCompletionObservation | null>(null);
const activationObservation = ref<MarkdownCompletionObservation | null>(null);
const requiredActivationKinds = ref<ReadonlySet<MarkdownFeatureActivationKind>>(
    new Set()
);
const activatedKinds = ref<ReadonlySet<MarkdownFeatureActivationKind>>(new Set());
const completionFailed = ref(false);

const renderMarkdownIdentity = computed(
    () => renderObservation.value?.markdownIdentity ?? null
);
const activationMarkdownIdentity = computed(
    () => activationObservation.value?.markdownIdentity ?? null
);
const previewRenderComplete = computed(() =>
{
    const previewIdentity = props.preview?.sourceIdentity;
    const render = renderObservation.value;
    const activation = activationObservation.value;
    return Boolean(
        previewIdentity
            && !completionFailed.value
            && render?.previewIdentity === previewIdentity
            && activation?.previewIdentity === previewIdentity
            && render.markdownIdentity === activation.markdownIdentity
            && [...requiredActivationKinds.value].every(
                kind => activatedKinds.value.has(kind)
            )
    );
});

watch(
    () => [
        props.preview?.sourceIdentity ?? null,
        props.preview?.normalizedMarkdownSource ?? null
    ],
    resetPreviewCompletion,
    { flush: 'sync' }
);

function belongsToCurrentPreview(result: MarkdownRenderResult): boolean
{
    return Boolean(
        result.normalizedSource === props.preview?.normalizedMarkdownSource
    );
}

function currentObservation(
    result: MarkdownRenderResult
): MarkdownCompletionObservation | null
{
    if (!props.preview || !belongsToCurrentPreview(result))
    {
        return null;
    }
    return {
        previewIdentity: props.preview.sourceIdentity,
        markdownIdentity: result.sourceIdentity
    };
}

function isCurrentGeneration(contentVersion: number | string | null): boolean
{
    return Boolean(
        contentVersion === props.preview?.sourceIdentity
    );
}

function requiredKindsFor(
    result: MarkdownRenderResult
): ReadonlySet<MarkdownFeatureActivationKind>
{
    const required = new Set<MarkdownFeatureActivationKind>();
    if (result.features.includes('code_block'))
    {
        required.add('code-highlight');
    }
    if (result.features.includes('latex'))
    {
        required.add('latex');
    }
    if (result.features.includes('mermaid'))
    {
        required.add('mermaid');
    }
    return required;
}

function sameKinds(
    left: ReadonlySet<MarkdownFeatureActivationKind>,
    right: ReadonlySet<MarkdownFeatureActivationKind>
): boolean
{
    return left.size === right.size && [...left].every(kind => right.has(kind));
}

function observationsMatch(
    left: MarkdownCompletionObservation | null,
    right: MarkdownCompletionObservation
): boolean
{
    return left === null
        || left.previewIdentity === right.previewIdentity
        && left.markdownIdentity === right.markdownIdentity;
}

function handleRenderComplete(
    result: MarkdownRenderResult,
    contentVersion: number | string | null
): void
{
    if (!isCurrentGeneration(contentVersion) || completionFailed.value)
    {
        return;
    }
    const observation = currentObservation(result);
    const required = requiredKindsFor(result);
    if (!observation
        || !observationsMatch(activationObservation.value, observation)
        || requiredActivationKinds.value.size > 0
        && !sameKinds(requiredActivationKinds.value, required))
    {
        failPreviewCompletion();
        return;
    }
    renderObservation.value = observation;
    requiredActivationKinds.value = required;
}

function handleFeaturesActivated(
    activation: MarkdownFeatureActivationResult,
    result: MarkdownRenderResult,
    contentVersion: number | string | null
): void
{
    if (!isCurrentGeneration(contentVersion) || completionFailed.value)
    {
        return;
    }
    const observation = currentObservation(result);
    const required = requiredKindsFor(result);
    if (!observation
        || activation.errors.length > 0
        || !observationsMatch(renderObservation.value, observation)
        || !observationsMatch(activationObservation.value, observation)
        || requiredActivationKinds.value.size > 0
        && !sameKinds(requiredActivationKinds.value, required))
    {
        failPreviewCompletion();
        return;
    }

    activationObservation.value = observation;
    requiredActivationKinds.value = required;
    activatedKinds.value = new Set([
        ...activatedKinds.value,
        ...activation.activated
            .filter(item => item.count > 0)
            .map(item => item.kind)
    ]);
}

function handleRenderError(
    _error: unknown,
    contentVersion: number | string | null
): void
{
    if (isCurrentGeneration(contentVersion))
    {
        failPreviewCompletion();
    }
}

function failPreviewCompletion(): void
{
    clearPreviewCompletion();
    completionFailed.value = true;
}

function clearPreviewCompletion(): void
{
    renderObservation.value = null;
    activationObservation.value = null;
    requiredActivationKinds.value = new Set();
    activatedKinds.value = new Set();
}

function resetPreviewCompletion(): void
{
    clearPreviewCompletion();
    completionFailed.value = false;
}

</script>

<style scoped>
.preview-issues
 {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
}

.preview-issue
 {
    border: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-text-secondary);
    padding: 0.3rem 0.45rem;
    font-size: 12px;
    font-weight: 500;
}

.preview-issue--error
 {
    border-color: var(--fsusblog-color-error-border);
    color: var(--fsusblog-color-error-strong);
}

.author-preview
 {
    min-width: 0;

    --preview-radius-inline: var(--fsus-radius-control-small, 4px);
}

.author-preview :deep(:not(pre) > code)
 {
    border-radius: var(--preview-radius-inline) !important;
}

.author-preview__summary
 {
    color: var(--fsusblog-text-secondary);
}

.author-preview__cover img
 {
    display: block;
    max-width: 100%;
    height: auto;
}

.preview-empty
 {
    margin: 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
}
</style>
