<template>
  <div class="grow lg:w-2/3">
    <header class="mb-12 sm:mb-20">
      <h1 class="text-3xl sm:text-4xl font-bold text-[#0F0F11]">
        {{ siteTitle }}<span class="text-[#A1A1AA]">.</span>
      </h1>
      <p class="mt-4 text-sm sm:text-base text-[#8E8E93] max-w-xl leading-relaxed">
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
        :label="view.pagination.previous.label"
        variant="quiet"
        size="lg"
        :disabled="view.pagination.previous.disabled"
        :action="view.pagination.previous.action"
        :class="`-ml-4 ${view.pagination.previous.disabled ? themeTokens.articleList.paginationButtonDisabled : ''}`"
        @click="emit('page-prev')"
      />

      <span :class="themeTokens.articleList.paginationIndicator">{{ view.pagination.indicator }}</span>

      <UiButton
        :label="view.pagination.next.label"
        variant="quiet"
        size="lg"
        :disabled="view.pagination.next.disabled"
        :action="view.pagination.next.action"
        :class="`-mr-4 ${view.pagination.next.disabled ? themeTokens.articleList.paginationButtonDisabled : ''}`"
        @click="emit('page-next')"
      />
    </nav>
  </div>
</template>

<script setup lang="ts">
import ArticleCard from '@/components/ArticleCard.vue'
import { UiButton } from '@/components/ui'
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
