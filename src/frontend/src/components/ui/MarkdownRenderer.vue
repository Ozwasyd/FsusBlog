<template>
    <div
        class="blog-markdown-renderer markdown-body safe-inline-wrap"
        :class="{
            'markdown-body--article': props.mode === 'article',
            'markdown-body--document': props.mode === 'about',
            'markdown-body--preview': props.mode === 'preview' || props.mode === 'editor'
        }"
        data-fsus-surface="reading"
    >
        <ElMarkdownRenderer
            ref="rendererRef"
            :content="props.content"
            :content-version="props.contentVersion"
            :initial-render="props.initialRender"
            :allow-latex="props.allowLatex"
            :allow-mermaid="props.allowMermaid"
            :mode="props.mode"
            :base-url="props.baseUrl"
            :trusted-html-factory="toTrustedMarkdownHtml"
            :trusted-script-url-factory="toTrustedMarkdownWorkerScriptUrl"
            @features-activated="forwardFeaturesActivated"
            @render-complete="emit('render-complete', $event)"
            @render-error="emit('render-error', $event)"
        />
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type {
    MarkdownFeatureActivationResult,
    MarkdownRenderResult,
    MarkdownSafeRenderResult
} from '@/fsusui/markdown';
import {
    toTrustedMarkdownWorkerScriptUrl,
    toTrustedMarkdownHtml
} from '@/security/trustedTypesRuntime';
import '@/assets/markdown.css';

type MarkdownRenderMode = 'article' | 'about' | 'preview' | 'editor';
interface MarkdownRendererExpose {
    rootEl?: HTMLElement | null;
}
interface FsusMarkdownError {
    code?: string;
    message?: string;
}

const props = withDefaults(defineProps<{
    content: string;
    contentVersion?: number | string | null;
    initialRender?: MarkdownSafeRenderResult | null;
    allowLatex?: boolean;
    allowMermaid?: boolean;
    mode?: MarkdownRenderMode;
    baseUrl?: string | null;
}>(), {
    initialRender: null,
    contentVersion: null,
    allowLatex: true,
    allowMermaid: true,
    mode: 'article',
    baseUrl: null
});
const emit = defineEmits<{
    (
        e: 'features-activated',
        activation: MarkdownFeatureActivationResult,
        result: MarkdownRenderResult
    ): void;
    (e: 'render-complete', result: MarkdownRenderResult): void;
    (e: 'render-error', error: FsusMarkdownError): void;
}>();

const forwardFeaturesActivated = (
    activation: MarkdownFeatureActivationResult,
    result: MarkdownRenderResult
) => emit('features-activated', activation, result);

const rendererRef = ref<MarkdownRendererExpose | null>(null);
const rootEl = computed(() => rendererRef.value?.rootEl ?? null);
defineExpose({ rootEl });
</script>
