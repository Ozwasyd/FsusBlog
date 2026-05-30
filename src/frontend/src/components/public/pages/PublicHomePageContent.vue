<template>
  <HomeFeedSurface>
    <template #main>
      <div>
        <header class="mb-16 sm:mb-24">
          <h1 class="text-3xl sm:text-4xl lg:text-5xl font-bold text-[var(--fsusblog-text-primary)] tracking-normal leading-[1.1]">
            {{ siteTitleText }}<span class="text-[var(--fsusblog-text-muted)]">.</span>
          </h1>
          <p class="mt-6 text-base sm:text-lg text-[var(--fsusblog-text-tertiary)] max-w-xl leading-relaxed font-light">
            {{ siteDescriptionText }}
          </p>
        </header>

        <HomeArticleLoadingState v-if="loading" />

        <HomeArticleErrorState v-else-if="isError" @retry="emit('retry')" />

        <template v-else>
          <slot name="featured" />

          <PublicArticleList
            v-if="view.items.length > 0"
            :items="view.items"
            :pagination="view.pagination"
            :show-pagination="view.showPagination"
            :spa-navigation="spaNavigation"
            @navigate="emit('navigate', $event)"
            @page-prev="emit('page-prev')"
            @page-next="emit('page-next')"
          />

          <HomeArticleEmptyState v-else />
        </template>
      </div>
    </template>

    <template #aside>
      <slot name="aside">
        <div id="fsus-home-hot-articles-slot-content" class="min-h-[18rem]"></div>
      </slot>
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
  siteTitleText: string
  siteDescriptionText: string
  view: ArticleListViewContract
  loading?: boolean
  isError?: boolean
  spaNavigation?: boolean
}>()

const emit = defineEmits<{
  (event: 'retry'): void
  (event: 'navigate', href: string): void
  (event: 'page-prev'): void
  (event: 'page-next'): void
}>()
</script>
