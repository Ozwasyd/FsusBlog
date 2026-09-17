<template>
    <PublicHomePageContent
        :view="editorialView"
        :loading="loading"
        :is-error="isError"
        :spa-navigation="spaNavigation"
        :show-aside="showHomeAside"
        :has-recommendations="hasEditorialRecommendations"
        :show-article-cta="false"
        @retry="loadArticles(true)"
        @navigate="navigateToArticle"
        @page-prev="handlePageChange(currentPage - 1)"
        @page-next="handlePageChange(currentPage + 1)"
    >
        <template #featured>
            <FeaturedArticlesSection
                v-if="featuredLoading || editorialComposition.leadArticle"
                :article="editorialComposition.leadArticle"
                :loading="featuredLoading"
            />
            <HomeTextFirstRecommendations
                v-if="!featuredLoading && editorialComposition.secondaryArticles.length > 0"
                :articles="editorialComposition.secondaryArticles"
            />
        </template>
        <template #aside>
            <!-- The home editorial selector owns every recommendation. Keeping the
           aside empty prevents an independently selected hot list from
           reintroducing duplicate article IDs. -->
        </template>
    </PublicHomePageContent>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';

import FeaturedArticlesSection from '@/components/home/FeaturedArticlesSection.vue';
import HomeTextFirstRecommendations from '@/components/home/HomeTextFirstRecommendations.vue';
import PublicHomePageContent from '@/components/public/pages/PublicHomePageContent.vue';
import { useHomeView } from '@/composables/useHomeView';
import { useHumanReadProof } from '@/composables/useHumanReadProof';
import { usePublicSpaNavigationMode } from '@/composables/usePublicSpaNavigationMode';
import { buildPublicHomeRouteKey } from '@/public-renderers/publicRouteIdentity';
import { createHomeEditorialPageState } from '@/view-contracts/homeSpotlight';

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
} = useHomeView();
const router = useRouter();
const spaNavigation = usePublicSpaNavigationMode;
// Hydration invariant: AOT/SSR, hydration, and SPA takeover all use the same
// pure selector and preserve each backend source's ordering.
const editorialState = computed(() => createHomeEditorialPageState({
    view: listView.value,
    featuredArticles: featuredArticles.value,
    hotArticles: hotArticles.value
}));
const editorialComposition = computed(() => editorialState.value.composition);
const editorialView = computed(() => editorialState.value.view);
const hasEditorialRecommendations = computed(() => editorialState.value.hasRecommendations);
// Secondary recommendations stay in the main editorial line, so the home
// shell has one readable column on both narrow and wide viewports.
const showHomeAside = false;
useHumanReadProof({
    scope: computed(() => 'site'),
    routeKey: computed(() => buildPublicHomeRouteKey()),
    enabled: computed(() => !loading.value && !isError.value)
});

const navigateToArticle = async (href: string): Promise<void> =>
{
    await router.push(href);
};
</script>
