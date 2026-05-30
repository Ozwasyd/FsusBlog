<template>
  <PublicHomePageContent
    :site-title-text="siteTitleText || initialSiteTitleText"
    :site-description-text="initialSiteDescriptionText"
    :view="listView"
    :loading="loading"
    :is-error="isError"
    :spa-navigation="true"
    @retry="loadArticles(true)"
    @navigate="navigateToArticle"
    @page-prev="handlePageChange(currentPage - 1)"
    @page-next="handlePageChange(currentPage + 1)"
  >
    <template #featured>
      <!-- Only render featured section after data is loaded or explicitly ready.
           Avoid rendering during hydration window to prevent DOM mismatch. -->
      <FeaturedArticlesSection
        v-if="featuredArticles.length > 0 || hotArticles.length > 0"
        :articles="featuredArticles"
        :hot-articles="hotArticles"
        :loading="featuredLoading"
        @navigate="navigateToArticle"
      />
    </template>
  </PublicHomePageContent>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import FeaturedArticlesSection from '@/components/home/FeaturedArticlesSection.vue'
import PublicHomePageContent from '@/components/public/pages/PublicHomePageContent.vue'
import { useHomeView } from '@/composables/useHomeView'
import { useHumanReadProof } from '@/composables/useHumanReadProof'
import { buildPublicHomeRouteKey } from '@/public-renderers/publicRouteIdentity'

const {
  siteTitleText,
  initialSiteTitleText,
  initialSiteDescriptionText,
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
useHumanReadProof({
  scope: computed(() => 'site'),
  routeKey: computed(() => buildPublicHomeRouteKey()),
  enabled: computed(() => !loading.value && !isError.value)
})

const navigateToArticle = async (href: string): Promise<void> => {
  await router.push(href)
}
</script>
