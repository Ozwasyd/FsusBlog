<template>
    <div class="flex flex-col lg:flex-row gap-12 lg:gap-24">

        <div class="grow lg:w-2/3">

            <header class="mb-12 sm:mb-20">
                <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">
                    {{ siteStore.isLoaded ? siteStore.siteInfo.title : '...' }}<span class="text-zinc-400">.</span>
                </h1>
                <p class="mt-4 text-sm sm:text-base text-zinc-500 max-w-xl leading-relaxed">
                    {{ siteStore.siteInfo.description }}
                </p>
            </header>

            <div class="flex flex-col gap-12 sm:gap-20">

                <template v-if="loading">
                    <div v-for="i in 3" :key="i" class="animate-pulse flex flex-col gap-4" aria-hidden="true">
                        <div class="h-3 bg-zinc-100 w-32 mb-2"></div>
                        <div class="h-7 bg-zinc-100 w-3/4"></div>
                        <div class="space-y-3 mt-2">
                            <div class="h-4 bg-zinc-100 w-full"></div>
                            <div class="h-4 bg-zinc-100 w-5/6"></div>
                        </div>
                    </div>
                </template>

                <!-- [修复 2026-02-23] 状态暴露：明确区分失败与空状态 -->
                <div v-else-if="isError" class="py-20 text-center">
                    <p class="text-sm font-medium text-zinc-400 uppercase tracking-widest">
                        数据加载异常
                    </p>
                    <button @click="loadArticles(true)" class="mt-4 text-xs font-bold underline hover:text-zinc-950 uppercase tracking-widest">
                        重试
                    </button>
                </div>

                <!-- 修复日期: 2026-02-20 -->
                <!-- 安全性保障：使用可选链操作符 -->
                <template v-else-if="articles?.length > 0">
                    <ArticleCard v-for="(article, index) in articles"
                                 :key="article.id"
                                 :article="article"
                                 :index="index" />
                </template>

                <div v-else class="py-20 text-center">
                    <p class="text-sm font-medium tracking-widest uppercase text-zinc-400">
                        没有找到文章。
                    </p>
                </div>
            </div>

            <nav v-if="totalPages > 1" 
                 class="mt-20 pt-8 border-t border-zinc-100 flex justify-between items-center"
                 aria-label="文章分页">
                <button @click="handlePageChange(currentPage - 1)"
                        :disabled="currentPage === 1 || loading"
                        class="text-xs font-bold tracking-[0.2em] uppercase transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-zinc-400 hover:text-zinc-950 p-4 -ml-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950">
                    上一页
                </button>

                <span class="text-xs font-mono font-medium text-zinc-300 tabular-nums">
                    {{ currentPage }} / {{ totalPages }}
                </span>

                <button @click="handlePageChange(currentPage + 1)"
                        :disabled="currentPage === totalPages || loading"
                        class="text-xs font-bold tracking-[0.2em] uppercase transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-zinc-400 hover:text-zinc-950 p-4 -mr-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950">
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

    // [修复 2026-02-23] P2 修复：常量化信令事件名，防止硬编码拼写错误
    const ARTICLE_SIGNALS = {
        CREATED: 'signalr:article-created',
        UPDATED: 'signalr:article-updated',
        DELETED: 'signalr:article-deleted',
        RESTORED: 'signalr:article-restored',
        RECONNECTED: 'signalr:reconnected'
    } as const;

    const siteStore = useSiteStore()

    const articles = ref<ArticleListItem[]>([])
    const loading = ref(true)
    const isError = ref(false)
    const total = ref(0)
    const currentPage = ref(1)
    const pageSize = ref(10)

    // [修复 2026-02-23] P1 修复：逻辑自洽，确保 totalPages 至少为 1 以对齐导航逻辑
    const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

    // [修复 2026-02-23] 物理安全性：组件挂载状态锁
    let isMounted = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let abortController: AbortController | null = null

    /**
     * 核心加载逻辑
     * [修复 2026-02-23] P0 修复：闭包快照隔离与物理控制器清理
     */
    const loadArticles = async (showLoading = true) => {
        // 1. 抢占中断：物理切断上一个未完成的任务
        if (abortController) abortController.abort()
        abortController = new AbortController()
        const currentSignal = abortController.signal

        if (showLoading) {
            loading.value = true
            isError.value = false
        }
        
        try {
            const res = await getArticles({
                page: currentPage.value,
                size: pageSize.value
            }, { signal: currentSignal })

            // 2. 物理竞态校验：仅在组件存活且信号有效时执行状态变更
            if (isMounted && !currentSignal.aborted) {
                // 3. 数据契约校验：确保 API 返回格式正确
                if (res && Array.isArray(res.items)) {
                    articles.value = res.items
                    total.value = Number(res.total) || 0
                    isError.value = false
                } else {
                    throw new Error('Malformed API Response Structure')
                }
            }

        } catch (error: any) {
            if (error.name === 'AbortError') return
            
            if (isMounted && !currentSignal.aborted) {
                console.error('[Home] Data loading error:', error.message)
                isError.value = true
                articles.value = []
                total.value = 0
            }
        } finally {
            // [修复 2026-02-23] P0 修复：稳健的控制器引用置空逻辑
            if (abortController?.signal === currentSignal) {
                abortController = null
            }
            if (isMounted && !currentSignal.aborted) {
                loading.value = false
            }
        }
    }

    /**
     * 核心信令调度中心
     * [修复 2026-02-23] P1 修复：引入挂载检查，防止卸载后的幽灵执行
     */
    const dispatchListUpdate = () => {
        if (debounceTimer) clearTimeout(debounceTimer);

        debounceTimer = setTimeout(() => {
            if (isMounted) {
                console.log("[SignalR] 执行列表静默同步...");
                loadArticles(false);
            }
            debounceTimer = null;
        }, 500);
    }

    // 发布/还原同步
    const handleRemoteArticleCreated = () => {
        if (currentPage.value === 1) dispatchListUpdate();
    }

    /**
     * 更新同步
     * [修复 2026-02-23] P0 修复：严格校验 data 存在性与 ID 类型对齐
     */
    const handleRemoteArticleUpdated = (e: Event) => {
        const data = (e as CustomEvent).detail;
        // 逻辑自洽：物理排除空数据，统一转化为字符串进行稳定比对
        if (!data?.articleId) return;
        
        const targetId = String(data.articleId);
        const exists = articles.value.some(a => String(a.id) === targetId);
        if (exists) {
            dispatchListUpdate();
        }
    }

    // 删除同步
    const handleRemoteArticleDeleted = () => {
        dispatchListUpdate();
    }

    // 断线重连同步
    const handleSignalRReconnected = () => {
        if (isMounted) loadArticles(false);
    }

    const handlePageChange = (page: number) => {
        if (page < 1 || page > totalPages.value || loading.value) return
        currentPage.value = page
        loadArticles()
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    onMounted(() => {
        isMounted = true;
        loadArticles();
        
        // 物理注册：使用常量表进行信令绑定
        window.addEventListener(ARTICLE_SIGNALS.CREATED, handleRemoteArticleCreated);
        window.addEventListener(ARTICLE_SIGNALS.UPDATED, handleRemoteArticleUpdated);
        window.addEventListener(ARTICLE_SIGNALS.DELETED, handleRemoteArticleDeleted);
        window.addEventListener(ARTICLE_SIGNALS.RESTORED, handleRemoteArticleCreated);
        window.addEventListener(ARTICLE_SIGNALS.RECONNECTED, handleSignalRReconnected);
    })

    onUnmounted(() => {
        // [修复 2026-02-23] 逻辑自洽：物理清理
        isMounted = false;
        if (debounceTimer) clearTimeout(debounceTimer);
        if (abortController) abortController.abort();
        
        window.removeEventListener(ARTICLE_SIGNALS.CREATED, handleRemoteArticleCreated);
        window.removeEventListener(ARTICLE_SIGNALS.UPDATED, handleRemoteArticleUpdated);
        window.removeEventListener(ARTICLE_SIGNALS.DELETED, handleRemoteArticleDeleted);
        window.removeEventListener(ARTICLE_SIGNALS.RESTORED, handleRemoteArticleCreated);
        window.removeEventListener(ARTICLE_SIGNALS.RECONNECTED, handleSignalRReconnected);
    })
</script>

<style scoped>
    @reference "@/assets/main.css";
    
    button {
        -webkit-tap-highlight-color: transparent;
    }
</style>