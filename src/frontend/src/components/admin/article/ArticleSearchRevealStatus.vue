<template>
    <output
        class="article-search-reveal-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        :aria-label="label"
    >
        {{ label }}: {{ statusLabels[currentPresentation?.status ?? 'unavailable'] }}
        <template v-if="currentPresentation?.status === 'ready' && currentPresentation.precision !== null">
            · {{ precisionLabels[currentPresentation.precision] }}
        </template>
    </output>
</template>

<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue';

import type { ArticleEditorSearchRuntime } from '@/services/authoring/articleEditorSearchRuntime';
import type { ArticleSearchRevealPresentation } from '@/services/authoring/articleSearchRevealPresentation';

/**
 * Read-only command availability, never a focus/viewport success acknowledgement.
 * Consume either the original search lifecycle or a host-refreshed projection.
 * A cleared lifecycle removes availability and its previous precision. Mixed
 * inputs are unavailable. Raw reasons and command digests are never rendered.
 */
const props = defineProps<{
    presentation?: ArticleSearchRevealPresentation | null;
    search?: ArticleEditorSearchRuntime;
    label: string;
    statusLabels: Readonly<Record<ArticleSearchRevealPresentation['status'], string>>;
    precisionLabels: Readonly<Record<NonNullable<ArticleSearchRevealPresentation['precision']>, string>>;
}>();

// SSR reads the canonical snapshot without retaining a runtime subscription.
const runtimePresentation = shallowRef(props.search?.presentation ?? null);
onMounted(() => watch(() => props.search, (search, _previous, onCleanup) =>
{
    runtimePresentation.value = null;
    if (search)
    {
        onCleanup(search.subscribe(presentation =>
        {
            runtimePresentation.value = presentation;
        }));
    }
}, { immediate: true }));

const currentPresentation = computed(() => props.search
    ? props.presentation === undefined ? runtimePresentation.value : null
    : props.presentation ?? null);
</script>

<style scoped>
.article-search-reveal-status
{
    display: block;
    color: var(--el-text-color-secondary);
    overflow-wrap: anywhere;
}
</style>
