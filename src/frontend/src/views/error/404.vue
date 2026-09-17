<template>
    <main
        class="blog-page-shell error-page-shell min-h-[75vh] px-5 py-10 sm:px-8 sm:py-16"
        aria-labelledby="not-found-page-title"
    >
        <section class="mx-auto w-full max-w-xl animate-in fade-in transition-fsus transition-fsus-fast">
            <p
                class="mb-4 text-sm font-bold leading-6 text-[var(--fsusblog-text-muted)]"
                aria-hidden="true"
            >
                {{ copy.codePrefix }}<span class="text-[var(--fsusblog-text-muted)]">.</span>
            </p>

            <div class="safe-inline-wrap">
                <h1
                    id="not-found-page-title"
                    class="text-2xl font-bold leading-tight tracking-normal text-[var(--fsusblog-text-primary)] sm:text-3xl"
                >
                    {{ copy.title }}
                </h1>
                <p class="mt-4 text-sm font-normal leading-7 text-[var(--fsusblog-text-secondary)]">
                    {{ copy.description }}
                </p>

                <div class="mt-6 flex flex-col gap-3 sm:flex-row">
                    <ElButton
                        :tag="RouterLink"
                        to="/"
                        type="primary"
                    >
                        {{ copy.homeCta }}
                    </ElButton>
                    <ElButton
                        :tag="RouterLink"
                        to="/search"
                    >
                        {{ copy.searchCta }}
                    </ElButton>
                    <ElButton
                        :tag="RouterLink"
                        to="/archive"
                    >
                        {{ copy.archiveCta }}
                    </ElButton>
                </div>
            </div>
        </section>
    </main>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';

import { useHumanReadProof } from '@/composables/useHumanReadProof';
import { useI18nText } from '@/composables/useI18nText';

const { messages } = useI18nText();
const copy = computed(() => messages.value.errors.notFound);

const route = useRoute();

useHumanReadProof({
    scope: computed(() => 'site'),
    routeKey: computed(() => `not-found:${normalizeNotFoundPath(route.fullPath)}`)
});

function normalizeNotFoundPath(value: string): string
{
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length > 0 ? normalized.slice(0, 96) : '/';
}
</script>

<style scoped>
@reference "@/assets/main.css";

.error-page-shell
 {
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-primary);
}
</style>
