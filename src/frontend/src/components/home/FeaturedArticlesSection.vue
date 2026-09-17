<template>
    <section
        v-if="loading || article"
        class="featured-articles-section home-editorial-section home-editorial-section--lead mb-10 sm:mb-12"
        data-fsus-surface="reading"
        data-fsus-motion-surface="home-featured-article"
        :aria-labelledby="article ? 'home-editorial-lead-title' : undefined"
        :aria-label="!article && loading ? copy.leadLoadingLabel : undefined"
    >
        <header class="home-editorial-section__header mb-5 border-b border-[var(--fsusblog-panel-border)] pb-3">
            <h2 class="text-xl font-bold leading-[1.2] tracking-normal text-[var(--fsusblog-text-primary)]">
                {{ copy.leadEyebrow }}
            </h2>
        </header>

        <ElSkeleton
            v-if="loading"
            class="fsusblog-skeleton-surface"
        >
            <template #template>
                <div class="grid gap-8 md:grid-cols-2 md:items-center">
                    <div class="aspect-video w-full overflow-hidden rounded-[var(--fsusblog-radius-reading-media)] md:aspect-[4/3]">
                        <ElSkeletonItem variant="image" />
                    </div>
                    <div class="space-y-4">
                        <div class="h-4 w-28"><ElSkeletonItem variant="text" /></div>
                        <div class="h-10 w-full"><ElSkeletonItem variant="h3" /></div>
                        <div class="h-10 w-2/3"><ElSkeletonItem variant="h3" /></div>
                    </div>
                </div>
            </template>
        </ElSkeleton>

        <article
            v-else-if="article"
            class="home-editorial-lead"
            data-home-editorial-lead
            :data-article-id="article.id"
            :data-home-lead-layout="hasCover ? 'media' : 'text'"
        >
            <RouterLink
                v-slot="{ href, navigate }"
                custom
                :to="articleHref(article.id)"
            >
                <a
                    :href="href"
                    class="group grid rounded-[var(--fsusblog-radius-panel)] outline-none"
                    :class="[
                        focusRingClass,
                        hasCover
                            ? 'gap-8 py-12 md:grid-cols-2 md:items-center md:py-16'
                            : 'py-12 md:py-16'
                    ]"
                    :aria-label="readFullLabel(article.title)"
                    @click="navigate"
                    @keydown.space.prevent="navigate()"
                >
                    <div
                        v-if="hasCover"
                        class="aspect-video w-full overflow-hidden rounded-[var(--fsusblog-radius-reading-media)] border border-[var(--fsusblog-panel-border)] shadow-none md:aspect-[4/3]"
                        data-content-cover="editorial-lead"
                        :data-cover-safe-area="coverPresentation?.safeArea"
                    >
                        <img
                            :src="coverPresentation?.url"
                            :alt="article.title"
                            class="h-full w-full object-cover object-center shadow-none"
                            width="960"
                            height="720"
                            sizes="(min-width: 768px) 23rem, calc(100vw - 3rem)"
                            loading="eager"
                            fetchpriority="high"
                            decoding="async"
                        />
                    </div>

                    <div :class="hasCover ? '' : 'max-w-3xl'">
                        <div class="mb-4 flex flex-wrap items-center gap-3">
                            <span class="text-xs tabular-nums font-medium normal-case text-[var(--fsusblog-text-primary)]">
                                {{ article.category.name }}
                            </span>
                            <span
                                class="h-px w-8 bg-[var(--fsusblog-panel-border)]"
                                aria-hidden="true"
                            />
                            <time
                                :datetime="article.createTime"
                                class="text-xs tabular-nums normal-case text-[var(--fsusblog-text-muted)]"
                            >
                                {{ formatTime(article.createTime) }}
                            </time>
                        </div>
                        <h1
                            id="home-editorial-lead-title"
                            class="home-editorial-lead__title text-[28px] font-bold leading-[1.15] tracking-normal text-[var(--fsusblog-text-primary)] transition-fsus transition-fsus-fast group-hover:text-[var(--fsusblog-color-primary)]"
                        >
                            {{ article.title }}
                        </h1>
                    </div>
                </a>
            </RouterLink>
        </article>
    </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { FeaturedArticleItem } from '@/api/article';
import { useI18nText } from '@/composables/useI18nText';
import { themeTokens } from '@/ui-tokens/themeTokens';
import { resolvePublicCoverPresentation } from '@/view-contracts/coverArt';

const props = defineProps<{
    article: FeaturedArticleItem | null;
    loading?: boolean;
}>();

const focusRingClass = themeTokens.focusRing;
const { messages } = useI18nText();
const copy = computed(() => messages.value.layout.recommendations);
const coverPresentation = computed(() => resolvePublicCoverPresentation(props.article?.coverImageUrl));
const hasCover = computed(() => coverPresentation.value !== null);
const articleHref = (id: number) => `/article/${id}`;
const readFullLabel = (title: string): string => copy.value.ariaReadFull.replace('{title}', title);

const formatTime = (isoString: string): string =>
{
    const normalized = String(isoString ?? '').trim();
    return normalized.length >= 10 ? normalized.slice(0, 10) : '-';
};
</script>

<style scoped>
@media (prefers-reduced-motion: reduce)
 {
    .home-editorial-lead a,
    .home-editorial-lead h1
 {
        transition-duration: 1ms;
    }
}
</style>
