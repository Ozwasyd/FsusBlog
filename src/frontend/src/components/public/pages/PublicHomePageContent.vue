<template>
  <HomeFeedSurface :show-aside="showAside && Boolean($slots.aside)">
    <template #main>
      <div data-fsus-motion-surface="home-hero">
        <HomeArticleLoadingState v-if="loading" />

        <HomeArticleErrorState v-else-if="isError" @retry="emit('retry')" />

        <template v-else>
          <div
            id="fsus-home-secondary-content-sentinel"
            class="h-px w-px overflow-hidden opacity-0"
            aria-hidden="true"
          />

          <slot name="featured" />

          <section
            v-if="view.items.length > 0"
            class="home-editorial-section home-editorial-section--feed"
            aria-labelledby="home-feed-heading"
            data-home-feed-section
            data-home-punctuation-motif="metadata"
          >
            <header class="home-editorial-section__header mb-5 border-b border-[var(--fsusblog-panel-border)] pb-3">
              <h2
                id="home-feed-heading"
                class="text-xl font-bold leading-[1.2] tracking-normal text-[var(--fsusblog-text-primary)]"
                data-home-feed-heading
              >
                {{ copy.feedEyebrow }}
              </h2>
            </header>

            <PublicArticleList
              :items="view.items"
              :pagination="view.pagination"
              :show-pagination="view.showPagination"
              :show-read-cta="showArticleCta !== false"
              :spa-navigation="spaNavigation"
              @navigate="emit('navigate', $event)"
              @page-prev="emit('page-prev')"
              @page-next="emit('page-next')"
            />
          </section>

          <HomeArticleEmptyState v-else-if="!hasRecommendations" />
        </template>
      </div>
    </template>

    <template #aside>
      <slot name="aside" />
    </template>
  </HomeFeedSurface>
</template>

<script setup lang="ts">
import HomeArticleLoadingState from '@/components/home/HomeArticleLoadingState.vue'
import HomeArticleErrorState from '@/components/home/HomeArticleErrorState.vue'
import HomeArticleEmptyState from '@/components/home/HomeArticleEmptyState.vue'
import HomeFeedSurface from '@/components/public/HomeFeedSurface.vue'
import PublicArticleList from '@/components/public/PublicArticleList.vue'
import { FSUSBLOG_LAYOUT_COPY } from '@/copy'
import type { ArticleListViewContract } from '@/view-contracts/articleList'

defineProps<{
  view: ArticleListViewContract
  loading?: boolean
  isError?: boolean
  spaNavigation?: boolean
  showAside?: boolean
  hasRecommendations?: boolean
  showArticleCta?: boolean
}>()

const emit = defineEmits<{
  (event: 'retry'): void
  (event: 'navigate', href: string): void
  (event: 'page-prev'): void
  (event: 'page-next'): void
}>()

const copy = FSUSBLOG_LAYOUT_COPY.recommendations

</script>

<style scoped>
.home-editorial-section--feed :deep(.ui-article-list) {
  gap: 40px;
}

.home-editorial-section--feed :deep(.ui-article-card) {
  gap: 16px;
}

.home-editorial-section--feed :deep(.ui-article-meta) {
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
}

.home-editorial-section--feed :deep(.ui-article-title) {
  color: var(--fsusblog-text-heading);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.25;
}

.home-editorial-section--feed :deep(.ui-article-summary) {
  margin-top: 8px;
  color: var(--fsusblog-text-secondary);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.6;
}

</style>
