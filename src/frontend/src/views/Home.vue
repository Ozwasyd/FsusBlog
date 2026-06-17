<template>
  <PublicHomePageContent
    :view="listView"
    :loading="loading"
    :is-error="isError"
    :spa-navigation="spaNavigation"
    :show-aside="showHomeAside"
    @retry="loadArticles(true)"
    @navigate="navigateToArticle"
    @page-prev="handlePageChange(currentPage - 1)"
    @page-next="handlePageChange(currentPage + 1)"
  >
    <template #featured>
      <!-- Only render featured section after data is loaded or explicitly ready.
           Avoid rendering during hydration window to prevent DOM mismatch. -->
      <FeaturedArticlesSection
        v-if="homeSecondaryLayout === 'loading' || homeSecondaryLayout === 'spotlight'"
        :articles="spotlightArticles"
        :loading="featuredLoading"
      />
      <HomeTextFirstRecommendations
        v-else-if="homeSecondaryLayout === 'text-first'"
        :articles="hotArticles"
      />
    </template>
    <template #aside>
      <HomeHotArticlesAside :articles="hotArticles" />
    </template>
  </PublicHomePageContent>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import FeaturedArticlesSection from '@/components/home/FeaturedArticlesSection.vue'
import HomeHotArticlesAside from '@/components/home/HomeHotArticlesAside.vue'
import HomeTextFirstRecommendations from '@/components/home/HomeTextFirstRecommendations.vue'
import PublicHomePageContent from '@/components/public/pages/PublicHomePageContent.vue'
import { useHomeView } from '@/composables/useHomeView'
import { useHumanReadProof } from '@/composables/useHumanReadProof'
import { usePublicSpaNavigationMode } from '@/composables/usePublicSpaNavigationMode'
import { buildPublicHomeRouteKey } from '@/public-renderers/publicRouteIdentity'
import { resolveHomeSecondaryLayout, selectHomeSpotlightCandidates } from '@/view-contracts/homeSpotlight'

const {
  listView,
  featuredArticles,
  hotArticles,
  featuredLoading,
  currentPage,
  loading,
  isError,
  handlePageChange,
  loadArticles
} = useHomeView()
const router = useRouter()
const spaNavigation = usePublicSpaNavigationMode()
const spotlightArticles = computed(() => selectHomeSpotlightCandidates(featuredArticles.value))
const showHomeAside = computed(() => hotArticles.value.length > 0)
// Hydration invariant: secondary home layout uses the same pure selector for SSR, hydration, and takeover.
const homeSecondaryLayout = computed(() => resolveHomeSecondaryLayout({
  loading: featuredLoading.value,
  spotlightCandidates: spotlightArticles.value,
  hotArticles: hotArticles.value
}))
useHumanReadProof({
  scope: computed(() => 'site'),
  routeKey: computed(() => buildPublicHomeRouteKey()),
  enabled: computed(() => !loading.value && !isError.value)
})

const navigateToArticle = async (href: string): Promise<void> => {
  await router.push(href)
}
</script>
