<template>
    <output
        class="article-search-reveal-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        :aria-label="label"
    >
        {{ label }}: {{ statusLabels[presentation.status] }}
        <template v-if="presentation.status === 'ready' && presentation.precision !== null">
            · {{ precisionLabels[presentation.precision] }}
        </template>
    </output>
</template>

<script setup lang="ts">
import type { ArticleSearchRevealPresentation } from '@/services/authoring/articleSearchRevealPresentation';

/**
 * Read-only command availability, never a focus/viewport success acknowledgement.
 * The host supplies localized labels and a fresh canonical projection whenever
 * its command, context, binding or active search lease changes. Raw reasons and
 * command digests are deliberately not rendered.
 */
defineProps<{
    presentation: ArticleSearchRevealPresentation;
    label: string;
    statusLabels: Readonly<Record<ArticleSearchRevealPresentation['status'], string>>;
    precisionLabels: Readonly<Record<NonNullable<ArticleSearchRevealPresentation['precision']>, string>>;
}>();
</script>

<style scoped>
.article-search-reveal-status
{
    display: block;
    color: var(--el-text-color-secondary);
    overflow-wrap: anywhere;
}
</style>
