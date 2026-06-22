<template>
  <div class="blog-page-shell flex flex-col lg:flex-row gap-16 lg:gap-24 xl:gap-32">
    <div class="grow lg:w-2/3">
      <FilterHeader :view="view.header" />

      <div
        v-if="showSearchSort"
        class="mb-8 border-y border-[var(--fsusblog-panel-border)] py-4 text-[11px] font-bold leading-relaxed text-[var(--fsusblog-text-muted)]"
        aria-live="polite"
      >
        搜索范围：全站文章、标签或关键词。当前结果：{{ searchResultStateText }}
      </div>

      <div
        v-if="showSearchSort"
        class="filter-stack mb-16 border-b border-[var(--fsusblog-panel-border)] pb-10 flex items-center gap-8"
        data-fsus-motion-surface="search-panel"
      >
        <span class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">排序</span>
        <el-radio-group
          :model-value="searchSortMode"
          size="small"
          aria-label="搜索排序"
          @change="handleSortChange"
        >
          <el-radio-button
            v-for="mode in searchSortOptions"
            :key="mode.value"
            :value="mode.value"
          >
            {{ mode.label }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <FilterArticleLoadingState
        v-if="isLoadingState"
        :view="view.loading"
      />

      <PublicArticleList
        v-else-if="view.articles.length > 0 && !invalidTarget"
        :spa-navigation="spaNavigation"
        :items="view.articles"
        :pagination="paginationContract"
        :show-pagination="view.pagination.totalPages > 1"
        @navigate="emit('navigate', $event)"
        @page-prev="emit('page-prev')"
        @page-next="emit('page-next')"
      />

      <div v-else class="py-24 sm:py-32 md:py-48">
        <p class="text-[11px] tabular-nums font-bold text-[var(--fsusblog-text-subtle)] normal-case tracking-normal">
          {{ view.empty.title }}
        </p>
        <a
          :href="PUBLIC_FIXED_PATHS.home"
          class="mt-6 inline-flex items-center gap-2 text-sm font-bold text-[var(--fsusblog-text-primary)] hover:text-[var(--fsusblog-color-primary)]"
          @click="handleEmptyAction"
        >
          {{ view.empty.actionText }}
        </a>
      </div>
    </div>

    <aside class="hidden lg:block lg:w-64 shrink-0">
      <div class="sticky top-52">
        <a
          :href="PUBLIC_FIXED_PATHS.home"
          class="inline-flex items-center gap-6 text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)] hover:text-[var(--fsusblog-color-primary)] transition-colors group outline-none"
        >
          <el-icon class="transition-opacity duration-[var(--fsus-motion-control-fast)] group-hover:opacity-70" aria-hidden="true"><Back /></el-icon> 回到主页
        </a>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PaginationContract } from '@/ui-contracts/primitives'
import type { SearchSortMode } from '@/services/localSearch'
import PublicArticleList from '@/components/public/PublicArticleList.vue'
import FilterHeader from '@/components/filter/FilterHeader.vue'
import FilterArticleLoadingState from '@/components/filter/FilterArticleLoadingState.vue'
import { PUBLIC_FIXED_PATHS } from '@/public-renderers/publicRoutePaths'
import { Back } from '@/fsusui/icons'
import type { FilterPageViewContract } from '@/view-contracts/filterView'

const props = defineProps<{
  view: FilterPageViewContract
  invalidTarget: boolean
  isLoadingState: boolean
  spaNavigation?: boolean
  showSearchSort?: boolean
  searchSortMode?: SearchSortMode
  searchSortOptions?: ReadonlyArray<{
    value: SearchSortMode
    label: string
  }>
}>()

const emit = defineEmits<{
  (event: 'navigate', href: string): void
  (event: 'page-prev'): void
  (event: 'page-next'): void
  (event: 'sort-change', mode: SearchSortMode): void
}>()

const handleSortChange = (value: string | number | boolean | undefined): void => {
  if (value === 'relevance' || value === 'latest' || value === 'hot') {
    emit('sort-change', value)
  }
}

const handleEmptyAction = (event: MouseEvent): void => {
  if (!props.spaNavigation) {
    return
  }

  event.preventDefault()
  emit('navigate', PUBLIC_FIXED_PATHS.home)
}

const paginationContract = computed<PaginationContract>(() => ({
  previous: {
    label: '上一页',
    disabled: !props.view.pagination.canGoPrev,
    action: { action: 'page-prev' }
  },
  next: {
    label: '下一页',
    disabled: !props.view.pagination.canGoNext,
    action: { action: 'page-next' }
  },
  indicator: props.view.pagination.pageIndicatorText
}))

const searchResultStateText = computed(() => {
  if (props.isLoadingState) {
    return '正在检索'
  }

  if (props.invalidTarget) {
    return '搜索目标不可用'
  }

  if (props.view.articles.length === 0) {
    return props.view.filterType === 'search'
      ? `${props.view.empty.title}`
      : '本页暂时没有文章'
  }

  return `本页显示 ${props.view.articles.length} 篇，${props.view.pagination.pageIndicatorText}`
})
</script>

<style scoped>
.filter-stack {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

@media (max-width: 640px) {
  .filter-stack {
    width: 100%;
    align-items: stretch;
    flex-direction: column;
  }

  .filter-stack > * {
    min-width: 0;
  }
}
</style>
