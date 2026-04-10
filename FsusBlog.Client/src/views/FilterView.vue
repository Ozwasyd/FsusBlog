<template>
  <div class="flex flex-col lg:flex-row gap-12 lg:gap-24 subpixel-antialiased">
    <div class="grow lg:w-2/3">
      <FilterHeader :view="filterView.header" />

      <div class="flex flex-col gap-12 sm:gap-20">
        <FilterArticleLoadingState
          v-if="isLoadingState && !shouldDelayLoadingSkeleton"
          :view="filterView.loading"
        />

        <AotHost
          v-else-if="aotRenderedHtml"
          class="aot-filter-list"
          :html="aotRenderedHtml"
        />

        <template v-else-if="filterView.articles.length > 0">
          <TransitionGroup name="list-fade-up" tag="div" class="flex flex-col gap-12 sm:gap-20">
            <ArticleCard
              v-for="(article, index) in filterView.articles"
              :key="article.id"
              :view="article"
              :index="index"
              :search-keyword="filterType === 'search' ? searchKeyword : ''"
            />
          </TransitionGroup>
        </template>

        <FilterArticleEmptyState v-else :view="filterView.empty" />
      </div>

      <nav v-if="!aotRenderedHtml && filterView.pagination.totalPages > 1" class="mt-24 pt-12 border-t border-zinc-100 flex justify-between items-center select-none">
        <button @click="handlePageChange(filterView.pagination.currentPage - 1)" :disabled="!filterView.pagination.canGoPrev" class="nav-btn" :aria-disabled="!filterView.pagination.canGoPrev">
          ← <span class="hidden xs:inline ml-2">上一页</span>
        </button>
        <span class="text-[10px] font-mono font-bold text-zinc-400 tracking-widest tabular-nums">
          {{ filterView.pagination.pageIndicatorText }}
        </span>
        <button @click="handlePageChange(filterView.pagination.currentPage + 1)" :disabled="!filterView.pagination.canGoNext" class="nav-btn" :aria-disabled="!filterView.pagination.canGoNext">
          <span class="hidden xs:inline mr-2">下一页</span> →
        </button>
      </nav>
    </div>

    <aside class="hidden lg:block lg:w-64 shrink-0">
      <div class="sticky top-32">
        <router-link :to="homeRoute" class="text-[10px] font-bold tracking-[0.2em] uppercase text-zinc-400 hover:text-zinc-950 transition-colors flex items-center gap-3 group">
          <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span> 回到主页
        </router-link>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import AotHost from '@/components/AotHost.vue'
import { useFilterView } from '@/composables/useFilterView'
import ArticleCard from '@/components/ArticleCard.vue'
import FilterHeader from '@/components/filter/FilterHeader.vue'
import FilterArticleLoadingState from '@/components/filter/FilterArticleLoadingState.vue'
import FilterArticleEmptyState from '@/components/filter/FilterArticleEmptyState.vue'

const {
  filterType,
  searchKeyword,
  isLoadingState,
  filterView,
  handlePageChange,
  aotRenderedHtml,
  shouldDelayLoadingSkeleton
} = useFilterView()

const homeRoute = { name: 'Home' } as const
</script>

<style scoped>
@reference "@/assets/main.css";

.list-fade-up-enter-active {
  transition: all 0.6s cubic-bezier(0.22, 1, 0.36, 1);
  transition-delay: calc(var(--index) * 0.08s);
}
.list-fade-up-enter-from {
  opacity: 0;
  transform: translateY(30px);
}

.nav-btn {
  @apply text-[10px] font-bold tracking-[0.2em] uppercase transition-all duration-300 disabled:opacity-10 text-zinc-400 hover:text-zinc-950 py-4 outline-none focus-visible:ring-1 focus-visible:ring-zinc-950;
}
</style>
