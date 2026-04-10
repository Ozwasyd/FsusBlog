<template>
    <HomeFeedSurface>
        <template #main>
            <div class="flex flex-col gap-12 sm:gap-20">
                <HomeArticleLoadingState v-if="loading" />

                <HomeArticleErrorState v-else-if="isError" @retry="loadArticles(true)" />

                <template v-else-if="articles?.length > 0">
                    <PublicArticleList
                        :items="articles"
                        :pagination="paginationContract"
                        :show-pagination="totalPages > 1"
                        :spa-navigation="true"
                        @navigate="navigateToArticle"
                        @page-prev="handlePageChange(currentPage - 1)"
                        @page-next="handlePageChange(currentPage + 1)"
                    />
                </template>

                <HomeArticleEmptyState v-else />
            </div>
        </template>

        <template #aside>
            <HotArticlesCard v-if="runtimeReady" />
            <section
                v-else
                class="public-aside-placeholder rounded-3xl border border-zinc-100 bg-zinc-50/60 px-6 py-8"
                aria-hidden="true"
            >
                <h2 class="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">
                    热门文章
                </h2>
                <div class="space-y-6">
                    <div v-for="i in 5" :key="i" class="flex items-start gap-4">
                        <div class="w-6 text-sm font-mono text-zinc-200">0{{ i }}</div>
                        <div class="flex-1 space-y-2 pt-0.5">
                            <div class="h-3 rounded-sm bg-zinc-100"></div>
                            <div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div>
                        </div>
                    </div>
                </div>
            </section>
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
