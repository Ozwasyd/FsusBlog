<template>
    <HomeFeedSurface>
        <template #main>
            <HomeArticleLoadingState v-if="loading" />

            <HomeArticleErrorState v-else-if="isError" @retry="loadArticles(true)" />

            <PublicArticleList
                v-else-if="articles?.length > 0"
                :items="articles"
                :pagination="paginationContract"
                :show-pagination="totalPages > 1"
                :spa-navigation="true"
                @navigate="navigateToArticle"
                @page-prev="handlePageChange(currentPage - 1)"
                @page-next="handlePageChange(currentPage + 1)"
            />

            <HomeArticleEmptyState v-else />
        </template>

        <template #aside>
            <HotArticlesCard v-if="runtimeReady" />
        </template>
    </HomeFeedSurface>
</template>

<script setup lang="ts">
    import { computed } from 'vue'
    import { useRouter } from 'vue-router'
    import HotArticlesCard from '@/components/HotArticlesCard.vue'
    import HomeArticleLoadingState from '@/components/home/HomeArticleLoadingState.vue'
    import HomeArticleErrorState from '@/components/home/HomeArticleErrorState.vue'
    import HomeArticleEmptyState from '@/components/home/HomeArticleEmptyState.vue'
    import HomeFeedSurface from '@/components/public/HomeFeedSurface.vue'
    import PublicArticleList from '@/components/public/PublicArticleList.vue'
    import { runtimeReady } from '@/bootstrap/runtimeGate'
    import { useHomeView } from '@/composables/useHomeView'
    import type { PaginationContract } from '@/ui-contracts/primitives'

    const {
        siteStore,
        siteTitleText,
        articles,
        currentPage,
        totalPages,
        loading,
        isError,
        canGoPrev,
        canGoNext,
        handlePageChange,
        loadArticles
    } = useHomeView()
    const router = useRouter()

    const paginationContract = computed<PaginationContract>(() => ({
        previous: {
            label: '上一页',
            variant: 'quiet',
            disabled: !canGoPrev.value,
            action: { action: 'page-prev' }
        },
        next: {
            label: '下一页',
            variant: 'quiet',
            disabled: !canGoNext.value,
            action: { action: 'page-next' }
        },
        indicator: `${currentPage.value} / ${totalPages.value}`
    }))

    const navigateToArticle = async (href: string): Promise<void> => {
        await router.push(href)
    }
</script>

<style scoped>
    @reference "@/assets/main.css";
</style>
