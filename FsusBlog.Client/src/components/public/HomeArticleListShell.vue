<template>
  <div class="grow lg:w-2/3">
    <header class="mb-12 sm:mb-20">
      <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">
        {{ siteTitle }}<span class="text-zinc-400">.</span>
      </h1>
      <p class="mt-4 text-sm sm:text-base text-zinc-500 max-w-xl leading-relaxed">
        {{ siteDescription }}
      </p>
    </header>

    <div :class="themeTokens.articleList.container">
      <ArticleCard
        v-for="item in view.items"
        :key="item.id"
        :view="item"
        :index="item.card.index"
        :link-mode="linkMode"
      />
    </div>

    <nav v-if="view.showPagination" :class="themeTokens.articleList.pagination" aria-label="文章分页">
      <UiButton
        :contract="view.pagination.previous"
        :extra-class="`-ml-4 ${view.pagination.previous.disabled ? themeTokens.articleList.paginationButtonDisabled : ''}`"
        @click="emit('page-prev')"
      />

      <span :class="themeTokens.articleList.paginationIndicator">{{ view.pagination.indicator }}</span>

      <UiButton
        :contract="view.pagination.next"
        :extra-class="`-mr-4 ${view.pagination.next.disabled ? themeTokens.articleList.paginationButtonDisabled : ''}`"
        @click="emit('page-next')"
      />
    </nav>
  </div>
</template>

<script setup lang="ts">
import ArticleCard from '@/components/ArticleCard.vue'
import UiButton from '@/ui-adapters/element-plus/UiButton.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'
import type { ArticleListViewContract } from '@/view-contracts/articleList'

defineProps<{
  siteTitle: string
  siteDescription: string
  view: ArticleListViewContract
  linkMode?: 'router' | 'anchor'
}>()

const emit = defineEmits<{
  (event: 'page-prev'): void
  (event: 'page-next'): void
}>()
</script>
