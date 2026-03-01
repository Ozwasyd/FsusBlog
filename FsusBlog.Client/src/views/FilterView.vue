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
        <template v-if="loadingArticles || powProvider.isCalculating.value">
          <div v-for="i in 3" :key="i" class="flex flex-col gap-4" aria-hidden="true">
            <div class="flex gap-3">
              <div class="h-3 bg-zinc-50 w-24"></div>
              <div class="h-3 bg-zinc-50 w-16"></div>
            </div>
            <div class="h-8 bg-zinc-50 w-3/4 rounded-sm" :class="{ 'animate-pulse bg-zinc-100': powProvider.isCalculating.value }"></div>
            <div class="space-y-2.5 mt-1">
              <div class="h-4 bg-zinc-50 w-full"></div>
              <div class="h-4 bg-zinc-50 w-5/6"></div>
            </div>
          </div>
          <p v-if="powProvider.isCalculating.value" class="text-[9px] font-mono text-zinc-400 uppercase tracking-widest text-center animate-pulse">
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
              :search-keyword="filterType === 'search' ? String(route.query.q || '') : ''"
            />
          </TransitionGroup>
        </template>

        <div v-else class="py-32 text-center animate-in fade-in zoom-in-95 duration-1000">
          <p class="text-[10px] font-mono tracking-[0.4em] uppercase text-zinc-300 mb-8">
            {{ hasError ? '暂时无法加载内容' : '无相关内容' }}
          </p>
          <router-link :to="{ name: 'Home' }" class="text-[10px] font-bold tracking-widest uppercase py-3 px-6 border border-zinc-100 hover:bg-zinc-950 hover:text-white transition-all">
            返回首页
          </router-link>
        </div>
      </div>

      <nav v-if="totalPages > 1" class="mt-24 pt-12 border-t border-zinc-100 flex justify-between items-center select-none">
        <button @click="handlePageChange(currentPage - 1)" :disabled="currentPage === 1 || loadingArticles" class="nav-btn" :aria-disabled="currentPage === 1">
          ← <span class="hidden xs:inline ml-2">上一页</span>
        </button>
        <span class="text-[10px] font-mono font-bold text-zinc-400 tracking-widest tabular-nums">
          {{ String(currentPage).padStart(2, '0') }} / {{ String(totalPages).padStart(2, '0') }}
        </span>
        <button @click="handlePageChange(currentPage + 1)" :disabled="currentPage === totalPages || loadingArticles" class="nav-btn" :aria-disabled="currentPage === totalPages">
          <span class="hidden xs:inline mr-2">下一页</span> →
        </button>
      </nav>
    </div>

    <aside class="hidden lg:block lg:w-64 shrink-0">
      <div class="sticky top-32">
        <router-link :to="{ name: 'Home' }" class="text-[10px] font-bold tracking-[0.2em] uppercase text-zinc-400 hover:text-zinc-950 transition-colors flex items-center gap-3 group">
          <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span> 回到主页
        </router-link>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getArticles, searchArticles, type ArticleListItem } from '@/api/article' // [修复 2026-02-23] 移除未使用的 ArticleListRes 导入
import { getCategories } from '@/api/category'
import { getTags } from '@/api/tag'
import { usePow } from '@/composables/usePow'
import ArticleCard from '@/components/ArticleCard.vue'

// 信令常量定义
const SIGNALS = {
  CREATED: 'signalr:article-created',
  UPDATED: 'signalr:article-updated',
  DELETED: 'signalr:article-deleted',
  RESTORED: 'signalr:article-restored',
  RECONNECTED: 'signalr:reconnected'
} as const;

const route = useRoute()
const powProvider = usePow()

const filterType = ref<'category' | 'tag' | 'search'>('category')
const filterId = ref<number>(0)
const currentName = ref('')
const articles = ref<ArticleListItem[]>([])
const loadingMeta = ref(true)
const loadingArticles = ref(true)
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)
const hasError = ref(false) // [修复 2026-02-23] 确认为 hasError 状态变量

const labelText = computed(() => ({ category: '分类', tag: '标签', search: '搜索' }[filterType.value] || ''))
const totalPages = computed(() => Math.ceil(total.value / pageSize.value))

// 物理安全控制
let isMounted = false;
let abortController: AbortController | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 载入元数据名称
 */
const loadMetaName = async (signal: AbortSignal) => {
  if (filterType.value === 'search') {
    currentName.value = route.query.q ? `“${route.query.q}”` : '全站搜索'
    loadingMeta.value = false
    return
  }

  loadingMeta.value = true
  try {
    const fetchFn = filterType.value === 'category' ? getCategories : getTags
    const list = await fetchFn({ signal })
    
    if (isMounted && !signal.aborted) {
      const targetId = Number(route.params.id)
      const match = list.find((item: any) => item.id === targetId)
      currentName.value = match ? match.name : '未发现'
    }
  } catch (error: any) {
    if (error.name !== 'AbortError' && isMounted && !signal.aborted) {
      currentName.value = '加载失败'
    }
  } finally {
    if (isMounted && !signal.aborted) loadingMeta.value = false
  }
}

/**
 * 核心加载逻辑
 */
const loadArticles = async (showLoading = true, signal: AbortSignal) => {
  if (showLoading) {
    loadingArticles.value = true
    hasError.value = false // [修复 2026-02-23] 修正变量名为 hasError
  }

  try {
    const isSearch = filterType.value === 'search'
    const q = String(route.query.q || '').trim()
    
    if (isSearch && !q) {
      if (isMounted && !signal.aborted) {
        articles.value = []; total.value = 0;
        hasError.value = false;
      }
      return;
    }

    let res: any;
    if (isSearch) {
      res = await searchArticles({ keyword: q }, { signal, requiresPow: true } as any)
    } else {
      res = await getArticles({ 
        page: currentPage.value, 
        size: pageSize.value, 
        categoryId: filterType.value === 'category' ? filterId.value : undefined, 
        tagId: filterType.value === 'tag' ? filterId.value : undefined 
      }, { signal })
    }

    if (isMounted && !signal.aborted) {
      const items = res?.items || (Array.isArray(res) ? res : []);
      const count = res?.total ?? items.length;
      articles.value = items
      total.value = count
      hasError.value = false
    }
  } catch (error: any) {
    if (error.name === 'AbortError') return
    if (isMounted && !signal.aborted) {
      console.error('[FilterView] Load Fail:', error.message);
      hasError.value = true;
      articles.value = []; total.value = 0;
    }
  } finally {
    if (isMounted && !signal.aborted) loadingArticles.value = false
  }
}

/**
 * 初始化调度
 */
const init = async () => {
  if (abortController) abortController.abort()
  abortController = new AbortController()
  const currentSignal = abortController.signal

  hasError.value = false; // [修复 2026-02-23] 修正变量名为 hasError
  if (route.query.q !== undefined) {
    filterType.value = 'search'; filterId.value = 0
    powProvider.prewarm()
  } else {
    filterType.value = route.path.includes('/category') ? 'category' : 'tag'
    filterId.value = Number(route.params.id) || 0
  }
  currentPage.value = 1
  
  try {
    await Promise.allSettled([
      loadMetaName(currentSignal),
      loadArticles(true, currentSignal)
    ])
  } finally {
    if (abortController?.signal === currentSignal) {
      abortController = null
    }
  }
}

/**
 * 静默同步
 */
const dispatchSync = () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (isMounted && abortController === null) {
      const tempCtrl = new AbortController();
      loadArticles(false, tempCtrl.signal);
    }
    debounceTimer = null;
  }, 500);
}

const handleRemoteCreated = () => {
  if (filterType.value === 'search' || currentPage.value === 1) dispatchSync();
}

const handleRemoteUpdated = (e: Event) => {
  const data = (e as CustomEvent).detail;
  if (!data || !('articleId' in data)) return;
  
  const targetId = String(data.articleId);
  const exists = articles.value.some(a => String(a.id) === targetId);
  if (exists || filterType.value === 'search') dispatchSync();
}

const handleReconnected = () => {
  if (isMounted) {
    const tempCtrl = new AbortController();
    loadArticles(false, tempCtrl.signal);
  }
}

const handlePageChange = (page: number) => {
  if (page < 1 || page > totalPages.value || loadingArticles.value) return
  currentPage.value = page
  
  const tempCtrl = new AbortController();
  loadArticles(true, tempCtrl.signal);
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

watch([() => route.params.id, () => route.query.q], () => {
  init()
})

onMounted(() => {
  isMounted = true;
  init();
  
  window.addEventListener(SIGNALS.CREATED, handleRemoteCreated);
  window.addEventListener(SIGNALS.UPDATED, handleRemoteUpdated);
  window.addEventListener(SIGNALS.DELETED, dispatchSync);
  window.addEventListener(SIGNALS.RESTORED, handleRemoteCreated);
  window.addEventListener(SIGNALS.RECONNECTED, handleReconnected);
})

onUnmounted(() => {
  isMounted = false;
  if (debounceTimer) clearTimeout(debounceTimer);
  if (abortController) abortController.abort();
  
  window.removeEventListener(SIGNALS.CREATED, handleRemoteCreated);
  window.removeEventListener(SIGNALS.UPDATED, handleRemoteUpdated);
  window.removeEventListener(SIGNALS.DELETED, dispatchSync);
  window.removeEventListener(SIGNALS.RESTORED, handleRemoteCreated);
  window.removeEventListener(SIGNALS.RECONNECTED, handleReconnected);
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
  @apply text-[10px] font-bold tracking-[0.2em] uppercase transition-all duration-300 disabled:opacity-10 text-zinc-400 hover:text-zinc-950 py-4 outline-none focus-visible:ring-1 focus-visible:ring-zinc-950;
}
</style>