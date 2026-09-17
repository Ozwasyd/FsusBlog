<template>
    <ArticleDetailBody>
        <MarkdownRenderer
            :key="contentVersion ?? undefined"
            :content="content"
            :content-version="contentVersion"
            mode="preview"
            :base-url="baseUrl"
            @features-activated="forwardFeaturesActivated"
            @render-complete="forwardRenderComplete"
            @render-error="forwardRenderError"
        />
    </ArticleDetailBody>
</template>

<script setup lang="ts">
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue';
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue';
import type {
    MarkdownFeatureActivationResult,
    MarkdownRenderResult
} from '@/fsusui/markdown';

const props = withDefaults(defineProps<{
    content: string;
    contentVersion?: number | string | null;
    baseUrl?: string | null;
}>(), {
    contentVersion: null,
    baseUrl: null
});

const emit = defineEmits<{
    (
        e: 'features-activated',
        activation: MarkdownFeatureActivationResult,
        result: MarkdownRenderResult,
        contentVersion: number | string | null
    ): void;
    (
        e: 'render-complete',
        result: MarkdownRenderResult,
        contentVersion: number | string | null
    ): void;
    (
        e: 'render-error',
        error: unknown,
        contentVersion: number | string | null
    ): void;
}>();

const forwardFeaturesActivated = (
    activation: MarkdownFeatureActivationResult,
    result: MarkdownRenderResult
) => emit('features-activated', activation, result, props.contentVersion);
const forwardRenderComplete = (result: MarkdownRenderResult) =>
    emit('render-complete', result, props.contentVersion);
const forwardRenderError = (error: unknown) =>
    emit('render-error', error, props.contentVersion);
</script>
