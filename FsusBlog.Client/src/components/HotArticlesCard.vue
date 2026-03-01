<template>
  <section>
    <h2 class="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">
      热门文章
    </h2>
    
    <!-- [修复 2026-02-23] 逻辑自洽：对齐真实 DOM 结构 (ol > li)，消除 Hydration 成本 -->
    <ol v-if="loading" class="space-y-6 animate-pulse" aria-busy="true">
      <li v-for="i in CONFIG.MAX_ITEMS" :key="i" class="flex items-start gap-4">
        <div class="w-6 h-6 bg-zinc-100/80 mt-0.5"></div>
        <div class="flex-1 space-y-2.5 pt-1">
          <div class="h-3 bg-zinc-100/80 w-full"></div>
          <div class="h-3 bg-zinc-100/80 w-2/3"></div>
        </div>
      </li>
    </ol>

    <!-- [修复 2026-02-23] 状态暴露：区分数据加载失败与空数据的 UI 呈现 -->
    <div v-else-if="isError" class="text-sm text-zinc-400 py-4">
      排行榜加载失败，请稍后重试
    </div>
    <div v-else-if="!hotArticles.length" class="text-sm text-zinc-400 py-4">
      暂无热门文章
    </div>

    <ol v-else role="list" class="space-y-6">
      <li v-for="(article, index) in hotArticles" :key="article.id" class="group flex items-start gap-4">
        
        <span class="flex-none text-sm font-mono font-medium text-zinc-300 group-hover:text-zinc-950 transition-colors duration-300 w-6 pt-0.5">
          {{ formatIndex(index) }}
        </span>
        
        <div class="flex-auto flex flex-col gap-1.5">
          <router-link 
            :to="`/article/${article.id}`" 
            class="text-sm font-medium text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-relaxed line-clamp-2"
          >
            {{ article.title }}
          </router-link>
          
          <p class="text-xs text-zinc-400 font-medium tracking-tight">
            <!-- [修复 2026-02-23] 格式化大数：例如 1234567 -> 1.2M -->
            {{ formatViews(article.views) }} Views
          </p>
        </div>

      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { getHotArticles, type ArticleListItem } from '@/api/article'

// [修复 2026-02-23] 收敛魔法数字 (Magic Number)
const CONFIG = {
  MAX_ITEMS: 5,
  DEBOUNCE_MS: 500
}

// [修复 2026-02-23] 收敛隐式事件源，剔除 article-updated (不影响访问量排行)
const SIGNAL_EVENTS = [
  'signalr:article-created',
  'signalr:article-deleted',
  'signalr:article-restored',
  'signalr:reconnected'
] as const

const hotArticles = ref<ArticleListItem[]>([])
const loading = ref(true)
const isError = ref(false)

// 安全性保障：并发竞争校验
// [修复 2026-02-23] 废弃不可靠的客户端时间戳解析，依托物理事件流顺序配合防抖
let abortController: AbortController | null = null

// 性能最大化：防抖定时器
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 辅助方法：格式化与排序稳定保障
 */
const viewFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' });
const formatViews = (views: number) => viewFormatter.format(views);
const formatIndex = (index: number) => (index + 1).toString().padStart(2, '0');

/**
 * 核心加载逻辑 (逻辑自洽：支持静默更新)
 */
const loadHotArticles = async (showLoading = true) => {
  // 1. 物理中断旧请求
  if (abortController) {
    abortController.abort()
  }
  
  abortController = new AbortController()
  // 算法最优：建立闭包快照，解决 P0 级 finally 覆盖漏洞
  const currentController = abortController 

  if (showLoading) {
    loading.value = true
    isError.value = false
  }

  try {
    const res = await getHotArticles(CONFIG.MAX_ITEMS, { signal: currentController.signal })
    
    // 2. 状态覆盖免疫：只有当前存活的请求才能修改响应式数据
    if (currentController === abortController) {
      hotArticles.value = res
      isError.value = false
    }
  } catch (error: any) {
    if (error.name === 'AbortError') return
    
    if (currentController === abortController) {
      console.error('[HotArticles] Sync failed:', error)
      isError.value = true
    }
  } finally {
    if (currentController === abortController) {
      if (showLoading) loading.value = false
      abortController = null
    }
  }
}

/**
 * 热门列表防抖调度中心
 * [修复 2026-02-23] 统一拦截所有信号与重连风暴
 */
const dispatchHotUpdate = () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  
  debounceTimer = setTimeout(() => {
    console.log("[SignalR] 执行热门文章静默同步...");
    loadHotArticles(false)
    debounceTimer = null
  }, CONFIG.DEBOUNCE_MS)
}

// 逻辑自洽：信号拦截器
const handleRemoteChange = (_e: Event) => {
  dispatchHotUpdate();
}

// 断线重连同步
const handleSignalRReconnected = () => {
  dispatchHotUpdate();
}

onMounted(() => {
  loadHotArticles();
  
  // 集中化注册，解决隐式硬编码
  SIGNAL_EVENTS.forEach(event => {
    if (event === 'signalr:reconnected') {
      window.addEventListener(event, handleSignalRReconnected)
    } else {
      window.addEventListener(event, handleRemoteChange)
    }
  })
})

onUnmounted(() => {
  // 安全性保障：清理防抖任务与监听器
  if (abortController) abortController.abort()
  if (debounceTimer) clearTimeout(debounceTimer)
  
  SIGNAL_EVENTS.forEach(event => {
    if (event === 'signalr:reconnected') {
      window.removeEventListener(event, handleSignalRReconnected)
    } else {
      window.removeEventListener(event, handleRemoteChange)
    }
  })
})
</script>

<style scoped>
@reference "@/assets/main.css";

/* 强制保持行高，消除大数跳变带来的布局闪烁 (CLS 优化) */
.line-clamp-2 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  min-height: 2.75rem; 
}
</style>