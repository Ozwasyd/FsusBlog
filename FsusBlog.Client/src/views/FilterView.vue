<template>
  <div class="flex flex-col lg:flex-row gap-12 lg:gap-24 subpixel-antialiased">
    <div class="grow lg:w-2/3">
      <header class="mb-12 sm:mb-20 select-none">
        <p class="text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4 animate-in fade-in duration-700">
          {{ labelText }}
        </p>
        <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950 animate-in fade-in slide-in-from-bottom-3 duration-1000">
          <span v-if="loadingMeta" class="inline-block w-32 h-8 bg-zinc-100 animate-pulse rounded-sm"></span>
          <template v-else>
            {{ currentName }}
          </template>
        </h1>
      </header>

      <div class="flex flex-col gap-12 sm:gap-20">
        <template v-if="loadingArticles || isCalculating">
          <div v-for="i in 3" :key="i" class="flex flex-col gap-4">
            <div class="flex gap-3">
              <div class="h-3 bg-zinc-50 w-24"></div>
              <div class="h-3 bg-zinc-50 w-16"></div>
            </div>
            <div class="h-8 bg-zinc-50 w-3/4 rounded-sm" :class="{ 'animate-pulse bg-zinc-100': isCalculating }"></div>
            <div class="space-y-2.5 mt-1">
              <div class="h-4 bg-zinc-50 w-full"></div>
              <div class="h-4 bg-zinc-50 w-5/6"></div>
            </div>
          </div>
          <p v-if="isCalculating" class="text-[9px] font-mono text-zinc-400 uppercase tracking-widest text-center animate-pulse">
            Security verifying...
          </p>
        </template>

        <template v-else-if="articles.length > 0">
          <TransitionGroup name="list-fade-up" tag="div" class="flex flex-col gap-12 sm:gap-20">
            <ArticleCard 
              v-for="(article, index) in articles" 
              :key="article.id" 
              :article="article"
              :index="index"
              :search-keyword="filterType === 'search' ? (route.query.q as string) : ''"
            />
          </TransitionGroup>
        </template>

        <div v-else class="py-32 text-center animate-in fade-in zoom-in-95 duration-1000">
          <p class="text-[10px] font-mono tracking-[0.4em] uppercase text-zinc-300 mb-8">
            {{ hasError ? '暂时无法加载内容' : '无相关内容' }}
          </p>
          <router-link to="/" class="text-[10px] font-bold tracking-widest uppercase py-3 px-6 border border-zinc-100 hover:bg-zinc-950 hover:text-white transition-all">
            返回首页
          </router-link>
        </div>
      </div>

      <nav v-if="totalPages > 1" class="mt-24 pt-12 border-t border-zinc-100 flex justify-between items-center select-none">
        <button @click="handlePageChange(currentPage - 1)" :disabled="currentPage === 1" class="nav-btn">
          ← <span class="hidden xs:inline ml-2">上一页</span>
        </button>
        <span class="text-[10px] font-mono font-bold text-zinc-400 tracking-widest">
          {{ String(currentPage).padStart(2, '0') }} / {{ String(totalPages).padStart(2, '0') }}
        </span>
        <button @click="handlePageChange(currentPage + 1)" :disabled="currentPage === totalPages" class="nav-btn">
          <span class="hidden xs:inline mr-2">下一页</span> →
        </button>
      </nav>
    </div>

    <aside class="hidden lg:block lg:w-64 shrink-0">
      <div class="sticky top-32">
        <router-link to="/" class="text-[10px] font-bold tracking-[0.2em] uppercase text-zinc-400 hover:text-zinc-950 transition-colors flex items-center gap-3 group">
          <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span> 回到主页
        </router-link>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getArticles, searchArticles, type ArticleListItem, type ArticleListRes } from '@/api/article'
import { getCategories } from '@/api/category'
import { getTags } from '@/api/tag'
import { getPowChallenge } from '@/api/auth'
import { getBrowserFp } from '@/utils/fingerprint'
import { usePow } from '@/composables/usePow'
import ArticleCard from '@/components/ArticleCard.vue'

const route = useRoute()
const { calculate, isCalculating, prewarm } = usePow()

const filterType = ref<'category' | 'tag' | 'search'>('category')
const filterId = ref<number>(0)
const currentName = ref('')
const articles = ref<ArticleListItem[]>([])
const loadingMeta = ref(true)
const loadingArticles = ref(true)
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)
// 新增：错误熔断锁，防止无限重试死循环
const hasError = ref(false)

const labelText = computed(() => ({ category: '分类', tag: '标签', search: '搜索' }[filterType.value] || ''))
const totalPages = computed(() => Math.ceil(total.value / pageSize.value))

const lastEventTime = ref<number>(0)
let debounceTimer: any = null

/**
 * 核心：受控搜索流水线
 * 包含：挑战获取、Worker求解、错误重试
 */
const performSearch = async (keyword: string, retryCount = 0): Promise<ArticleListItem[]> => {
  try {
    // 1. 获取挑战包
    const challengeRes = await getPowChallenge({ action: 'search' });
    const { salt, difficulty, timestamp, signature } = challengeRes as any;

    // 2. 算力求解 (安全性保障：利用独立线程 Worker 执行)
    const fp = getBrowserFp();
    const { nonce } = await calculate(salt, fp, difficulty);

    // 3. 执行加固检索
    const res = await searchArticles({
      keyword,
      powSalt: salt,
      powNonce: nonce,
      powTimestamp: timestamp,
      difficulty: difficulty,
      powSignature: signature,
      browserFp: fp
    });

    // 处理不同的数据结构返回
    const rawData = (res as any).data ?? res;
    return Array.isArray(rawData) ? rawData : [];
  } catch (err: any) {
    // 逻辑自洽：处理后端 403 难度熔断升级
    if (err.response?.status === 403 && retryCount < 1) {
      console.warn("[PoW] 难度等级过时，正在提升算力尝试重试...");
      return performSearch(keyword, retryCount + 1);
    }
    throw err;
  }
}

/**
 * 核心加载逻辑
 */
const loadArticles = async (showLoading = true) => {
  // 核心修复：如果已发生错误，禁止再次触发加载，防止无限滚动死循环
  if ((loadingArticles.value || hasError.value) && showLoading) return
  
  if (showLoading) loadingArticles.value = true
  try {
    const isSearch = filterType.value === 'search'
    const q = (route.query.q as string) || ''
    
    if (isSearch) {
      if (!q.trim()) {
        articles.value = []; total.value = 0;
        return;
      }
      
      const list = await performSearch(q);
      
      articles.value = list.length > pageSize.value 
        ? list.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value)
        : list
      total.value = list.length
      hasError.value = false
    } else {
      const res = await getArticles({ 
        page: currentPage.value, 
        size: pageSize.value, 
        categoryId: filterType.value === 'category' ? filterId.value : undefined, 
        tagId: filterType.value === 'tag' ? filterId.value : undefined 
      }) as ArticleListRes

      articles.value = res.items
      total.value = res.total
      hasError.value = false
    }
  } catch (error) {
    console.error('[FilterView] Load Fail:', error);
    // 核心修复：标记错误状态，物理阻断后续调用
    hasError.value = true;
    articles.value = []; 
    total.value = 0;
  } finally {
    loadingArticles.value = false
  }
}

/**
 * 静默同步调度中心
 */
const dispatchSync = (eventTime: string) => {
  const eventTimestamp = new Date(eventTime).getTime();
  if (eventTimestamp <= lastEventTime.value) return;
  lastEventTime.value = eventTimestamp;

  if (debounceTimer) clearTimeout(debounceTimer);
  
  debounceTimer = setTimeout(() => {
    // 静默更新不检查 hasError，允许尝试恢复
    loadArticles(false);
    debounceTimer = null;
  }, 500);
}

const handleRemoteCreated = (e: Event) => {
  const data = (e as CustomEvent).detail;
  if (filterType.value === 'search' || currentPage.value === 1) {
    dispatchSync(data.eventTime);
  }
}

const handleRemoteUpdated = (e: Event) => {
  const data = (e as CustomEvent).detail;
  const exists = articles.value.some(a => a.id === Number(data.articleId));
  if (exists || filterType.value === 'search') {
    dispatchSync(data.eventTime);
  }
}

const handleRemoteDeleted = (e: Event) => {
  const data = (e as CustomEvent).detail;
  dispatchSync(data.eventTime);
}

const handleReconnected = () => {
  loadArticles(false);
}

const loadMetaName = async () => {
  loadingMeta.value = true
  try {
    if (filterType.value === 'search') {
      currentName.value = route.query.q ? `“${route.query.q}”` : '全站搜索'
    } else {
      const fetchFn = filterType.value === 'category' ? getCategories : getTags
      const list = await fetchFn()
      const match = list.find((item: any) => item.id === filterId.value)
      currentName.value = match ? match.name : '未发现'
    }
  } catch (error) { currentName.value = '加载失败' }
  finally { loadingMeta.value = false }
}

const init = async () => {
  // 必须先设置为 false，否则 loadArticles 内部的防重入判断会直接拦截请求
  hasError.value = false;
  loadingArticles.value = false; 

  if (route.query.q !== undefined) {
    filterType.value = 'search'; filterId.value = 0
    prewarm();
  } else {
    filterType.value = route.path.includes('/category') ? 'category' : 'tag'
    filterId.value = Number(route.params.id) || 0
  }
  currentPage.value = 1
  articles.value = [] 
  
  await Promise.all([loadMetaName(), loadArticles()])
}

const handlePageChange = (page: number) => {
  if (page < 1 || page > totalPages.value) return
  currentPage.value = page
  loadArticles()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

watch(() => [route.params.id, route.query.q], () => {
  init()
  window.scrollTo({ top: 0, behavior: 'smooth' })
})

onMounted(() => {
  init();
  window.addEventListener('signalr:article-created', handleRemoteCreated);
  window.addEventListener('signalr:article-updated', handleRemoteUpdated);
  window.addEventListener('signalr:article-deleted', handleRemoteDeleted);
  window.addEventListener('signalr:article-restored', handleRemoteCreated);
  window.addEventListener('signalr:reconnected', handleReconnected);
})

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  window.removeEventListener('signalr:article-created', handleRemoteCreated);
  window.removeEventListener('signalr:article-updated', handleRemoteUpdated);
  window.removeEventListener('signalr:article-deleted', handleRemoteDeleted);
  window.removeEventListener('signalr:article-restored', handleRemoteCreated);
  window.removeEventListener('signalr:reconnected', handleReconnected);
})
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
  @apply text-[10px] font-bold tracking-[0.2em] uppercase transition-all duration-300 disabled:opacity-10 text-zinc-400 hover:text-zinc-950 py-4;
}
</style>