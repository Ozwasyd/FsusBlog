<template>
  <HomeFeedSurface :show-aside="showAside">
    <template #main>
      <div>
        <HomeArticleLoadingState v-if="loading" />

        <HomeArticleErrorState v-else-if="isError" @retry="emit('retry')" />

        <template v-else>
          <div
            id="fsus-home-secondary-content-sentinel"
            class="h-px w-px overflow-hidden opacity-0"
            aria-hidden="true"
          />

          <slot name="featured" />

          <PublicArticleList
            v-if="view.items.length > 0"
            :items="view.items"
            :pagination="view.pagination"
            :show-pagination="view.showPagination"
            :show-read-cta="showArticleCta !== false"
            :spa-navigation="spaNavigation"
            @navigate="emit('navigate', $event)"
            @page-prev="emit('page-prev')"
            @page-next="emit('page-next')"
          />

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

</script>
