<template>
    <div class="flex flex-col lg:flex-row gap-12 lg:gap-24">

        <div class="grow lg:w-2/3">

            <header class="mb-12 sm:mb-20">
                <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">
                    {{ siteStore.siteInfo.title }}<span class="text-zinc-400">.</span>
                </h1>
                <p class="mt-4 text-sm sm:text-base text-zinc-500 max-w-xl leading-relaxed">
                    {{ siteStore.siteInfo.description }}
                </p>
            </header>

            <div class="flex flex-col gap-12 sm:gap-20">

                <template v-if="loading">
                    <div v-for="i in 3" :key="i" class="animate-pulse flex flex-col gap-4">
                        <div class="h-4 bg-zinc-100 w-32 mb-2"></div>
                        <div class="h-6 sm:h-8 bg-zinc-100 w-3/4"></div>
                        <div class="space-y-3 mt-2">
                            <div class="h-4 bg-zinc-100 w-full"></div>
                            <div class="h-4 bg-zinc-100 w-5/6"></div>
                        </div>
                    </div>
                </template>

                <!-- 修复日期: 2026-02-20 -->
                <!-- 安全性保障：使用可选链操作符，防止极端情况下 articles 变量本身损坏导致的渲染崩溃 -->
                <template v-else-if="articles?.length > 0">
                    <ArticleCard v-for="article in articles"
                                 :key="article.id"
                                 :article="article" />
                </template>

                <div v-else class="py-20 text-center">
                    <p class="text-sm font-medium tracking-widest uppercase text-zinc-400">
                        没有找到文章。
                    </p>
                </div>
            </div>

            <nav v-if="totalPages > 1" class="mt-20 pt-8 border-t border-zinc-100 flex justify-between items-center">
                <button @click="handlePageChange(currentPage - 1)"
                        :disabled="currentPage === 1"
                        class="text-xs font-bold tracking-[0.2em] uppercase transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-zinc-400 hover:text-zinc-950 p-4 -ml-4">
                    上一页
                </button>

                <span class="text-xs font-mono font-medium text-zinc-300">
                    {{ currentPage }} / {{ totalPages }}
                </span>

                <button @click="handlePageChange(currentPage + 1)"
                        :disabled="currentPage === totalPages"
                        class="text-xs font-bold tracking-[0.2em] uppercase transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-zinc-400 hover:text-zinc-950 p-4 -mr-4">
                    下一页
                </button>
            </nav>

        </div>

        <aside class="hidden lg:block lg:w-80 shrink-0 space-y-16 pt-8 lg:pt-0">
            <HotArticlesCard />
        </aside>

    </div>
</template>

<script setup lang="ts">
    import { ref, computed, onMounted, onUnmounted } from 'vue'
    import { getArticles, type ArticleListItem } from '@/api/article'
    import { useSiteStore } from '@/store/site'
    import HotArticlesCard from '@/components/HotArticlesCard.vue'
    import ArticleCard from '@/components/ArticleCard.vue'

    const siteStore = useSiteStore()

    const articles = ref<ArticleListItem[]>([])
    const loading = ref(true)
    const total = ref(0)
    const currentPage = ref(1)
    const pageSize = ref(10)

    const totalPages = computed(() => Math.ceil(total.value / pageSize.value))

    // 安全性保障：记录最后一次信令处理时间，防止并发竞争导致的旧盖新
    const lastEventTime = ref<number>(0)
    // 性能最大化：列表级防抖调度器
    let debounceTimer: any = null

    /**
     * 核心信令调度中心
     * 用于合并短时间内的多个文章变动信号
     */
    const dispatchListUpdate = (eventTime: string) => {
        const eventTimestamp = new Date(eventTime).getTime();

        // 并发校验：仅处理比当前已感知到的时间更晚的信号
        if (eventTimestamp <= lastEventTime.value) return;
        lastEventTime.value = eventTimestamp;

        if (debounceTimer) clearTimeout(debounceTimer);

        debounceTimer = setTimeout(() => {
            console.log("[SignalR] 执行列表静默同步...");
            loadArticles(false);
            debounceTimer = null;
        }, 500);
    }

    // 逻辑自洽：发布/还原同步
    const handleRemoteArticleCreated = (e: Event) => {
        const data = (e as CustomEvent).detail;
        // 仅在用户位于第一页时触发重载，确保新文章即时出现
        if (currentPage.value === 1) {
            dispatchListUpdate(data.eventTime);
        }
    }

    // 逻辑自洽：更新同步
    const handleRemoteArticleUpdated = (e: Event) => {
        const data = (e as CustomEvent).detail;
        // 检查更新的文章是否在当前列表中
        const exists = articles.value.some(a => a.id === Number(data.articleId));
        if (exists) {
            dispatchListUpdate(data.eventTime);
        }
    }

    // 逻辑自洽：删除同步
    const handleRemoteArticleDeleted = (e: Event) => {
        const data = (e as CustomEvent).detail;
        // 只要有删除信号，统一触发重载以确保分页和总数准确
        dispatchListUpdate(data.eventTime);
    }

    // 逻辑自洽：断线重连同步
    const handleSignalRReconnected = () => {
        console.log("[SignalR] 列表重连成功，执行补偿同步...");
        loadArticles(false);
    }

    const loadArticles = async (showLoading = true) => {
        if (showLoading) loading.value = true
        try {
            const res = await getArticles({
                page: currentPage.value,
                size: pageSize.value
            })

            // 修复日期: 2026-02-20
            // 逻辑自洽与安全性保障：容错处理，无论后端是否返回空值，前端都强制降级为安全空数组与 0
            // 彻底解决 Cannot read properties of undefined (reading 'length') 渲染错误
            articles.value = res?.items || []
            total.value = res?.total || 0

        } catch (error) {
            console.error('Data loading error:', error)
            // 异常处理兜底，避免保留脏数据
            articles.value = []
            total.value = 0
        } finally {
            loading.value = false
        }
    }

    const handlePageChange = (page: number) => {
        if (page < 1 || page > totalPages.value) return
        currentPage.value = page
        loadArticles()
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    onMounted(() => {
        loadArticles();
        window.addEventListener('signalr:article-created', handleRemoteArticleCreated);
        window.addEventListener('signalr:article-updated', handleRemoteArticleUpdated);
        window.addEventListener('signalr:article-deleted', handleRemoteArticleDeleted);
        window.addEventListener('signalr:article-restored', handleRemoteArticleCreated);
        window.addEventListener('signalr:reconnected', handleSignalRReconnected);
    })

    onUnmounted(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        window.removeEventListener('signalr:article-created', handleRemoteArticleCreated);
        window.removeEventListener('signalr:article-updated', handleRemoteArticleUpdated);
        window.removeEventListener('signalr:article-deleted', handleRemoteArticleDeleted);
        window.removeEventListener('signalr:article-restored', handleRemoteArticleCreated);
        window.removeEventListener('signalr:reconnected', handleSignalRReconnected);
    })
</script>

<style scoped>
    @reference "@/assets/main.css";
</style>