<template>
  <PublicFilterPageContent
    :view="filterView"
    :invalid-target="invalidTarget"
    :is-loading-state="isLoadingState"
    :spa-navigation="spaNavigation"
    :show-search-sort="shouldShowPublicFilterSearchSort(filterType)"
    :search-sort-mode="searchSortMode"
    :search-sort-options="searchSortOptions"
    @navigate="handleNavigate"
    @page-prev="handlePageChange(filterView.pagination.currentPage - 1)"
    @page-next="handlePageChange(filterView.pagination.currentPage + 1)"
    @sort-change="setSearchSortMode"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useFilterView } from '@/composables/useFilterView'
import { useHumanReadProof } from '@/composables/useHumanReadProof'
import { usePublicSpaNavigationMode } from '@/composables/usePublicSpaNavigationMode'
import PublicFilterPageContent from '@/components/public/pages/PublicFilterPageContent.vue'
import { shouldShowPublicFilterSearchSort } from '@/public-renderers/publicFilterSemantics'
import { resolvePublicFilterIdentity } from '@/public-renderers/publicRouteIdentity'

const {
  route,
  router,
  filterType,
  invalidTarget,
  searchSortMode,
  isLoadingState,
  filterView,
  handlePageChange,
  setSearchSortMode
} = useFilterView()
const spaNavigation = usePublicSpaNavigationMode

useHumanReadProof({
  scope: computed(() => 'site'),
  routeKey: computed(() => {
    const identity = resolvePublicFilterIdentity({
      routeName: typeof route.name === 'string' ? route.name : null,
      routeParam: route.params.id,
      searchKeyword: route.query.q
    })
    const searchKeyword = normalizeAnalyticsSearchKeyword(route.query.q)
    return identity.filterType === 'search' && searchKeyword
      ? `search:${searchKeyword}`
      : identity.routeKey
  }),
  enabled: computed(() => !isLoadingState.value && !invalidTarget.value)
})

const searchSortOptions = [
  { value: 'relevance', label: '相关' },
  { value: 'latest', label: '最新' },
  { value: 'hot', label: '热度' }
] as const

function handleNavigate(href: string): void {
  void router.push(href)
}

function normalizeAnalyticsSearchKeyword(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/\s+/g, ' ').slice(0, 64)
}
</script>
