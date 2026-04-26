<template>
  <div class="fsus-page-shell flex flex-col lg:flex-row gap-10 lg:gap-16 xl:gap-20 subpixel-antialiased">
    <div class="grow lg:w-2/3">
      <FilterHeader :view="filterView.header" />

      <div
        v-if="filterType === 'search'"
        class="filter-stack mb-10 border-b border-[#F4F4F5] pb-6"
      >
        <span class="text-[10px] font-bold uppercase text-[#A1A1AA]">排序</span>
        <button
          v-for="mode in searchSortOptions"
          :key="mode.value"
          type="button"
          class="rounded-[8px] px-3 py-2 text-[10px] font-bold uppercase transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
          :class="searchSortMode === mode.value ? 'bg-[#0F0F11] text-white hover:bg-[#2A599C]' : 'bg-[#F4F4F5] text-[#8E8E93] hover:text-[#2A599C]'"
          @click="setSearchSortMode(mode.value)"
        >
          {{ mode.label }}
        </button>
      </div>

      <FilterArticleLoadingState
        v-if="isLoadingState"
        :view="filterView.loading"
      />

      <TransitionGroup
        v-else-if="filterView.articles.length > 0"
        name="list-fade-up"
        tag="div"
        class="flex flex-col gap-10 sm:gap-14 lg:gap-16"
      >
        <ArticleCard
          v-for="(article, index) in filterView.articles"
          :key="article.id"
          :view="article"
          :index="index"
          :search-keyword="filterType === 'search' ? searchKeyword : ''"
        />
      </TransitionGroup>

      <FilterArticleEmptyState v-else :view="filterView.empty" />

      <nav v-if="filterView.pagination.totalPages > 1" class="mt-16 sm:mt-20 pt-8 sm:pt-10 border-t border-[#F4F4F5] flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-4 select-none">
        <button @click="handlePageChange(filterView.pagination.currentPage - 1)" :disabled="!filterView.pagination.canGoPrev" class="nav-btn" :aria-disabled="!filterView.pagination.canGoPrev">
          ← <span class="hidden xs:inline ml-2">上一页</span>
        </button>
        <span class="text-[10px] font-mono font-bold text-[#A1A1AA] tabular-nums">
          {{ filterView.pagination.pageIndicatorText }}
        </span>
        <button @click="handlePageChange(filterView.pagination.currentPage + 1)" :disabled="!filterView.pagination.canGoNext" class="nav-btn" :aria-disabled="!filterView.pagination.canGoNext">
          <span class="hidden xs:inline mr-2">下一页</span> →
        </button>
      </nav>
    </div>

    <aside class="hidden lg:block lg:w-64 shrink-0">
      <div class="sticky top-52">
        <router-link :to="homeRoute" class="rounded-[8px] text-[10px] font-bold uppercase text-[#A1A1AA] hover:text-[#2A599C] transition-colors flex items-center gap-5 group outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
          <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span> 回到主页
        </router-link>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { useFilterView } from '@/composables/useFilterView'
import ArticleCard from '@/components/ArticleCard.vue'
import FilterHeader from '@/components/filter/FilterHeader.vue'
import FilterArticleLoadingState from '@/components/filter/FilterArticleLoadingState.vue'
import FilterArticleEmptyState from '@/components/filter/FilterArticleEmptyState.vue'

const {
  filterType,
  searchKeyword,
  searchSortMode,
  isLoadingState,
  filterView,
  handlePageChange,
  setSearchSortMode,
} = useFilterView()

const homeRoute = { name: 'Home' } as const
const searchSortOptions = [
  { value: 'relevance', label: '相关' },
  { value: 'latest', label: '最新' },
  { value: 'hot', label: '热度' }
] as const
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
  @apply rounded-[8px] text-[10px] font-bold uppercase transition-all duration-300 disabled:opacity-10 text-[#A1A1AA] hover:text-[#2A599C] py-4 px-3 min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C];
}
</style>
