<template>
  <section>
    <h2 class="text-xs font-bold text-[#A1A1AA] uppercase mb-8">
      热门文章
    </h2>

    <ol v-if="loading" class="space-y-6 animate-pulse" aria-busy="true">
      <li v-for="i in CONFIG.MAX_ITEMS" :key="i" class="flex items-start gap-6">
        <div class="w-6 h-6 bg-[#F4F4F5]/80 mt-0.5"></div>
        <div class="flex-1 space-y-2.5 pt-1">
          <div class="h-3 bg-[#F4F4F5]/80 w-full"></div>
          <div class="h-3 bg-[#F4F4F5]/80 w-2/3"></div>
        </div>
      </li>
    </ol>

    <p v-else-if="isError" class="text-sm text-[#A1A1AA] py-4">
      排行榜加载失败，请稍后重试
    </p>
    <p v-else-if="!hotArticles.length" class="text-sm text-[#A1A1AA] py-4">
      暂无热门文章
    </p>

    <ol v-else role="list" class="space-y-6">
      <li v-for="(article, index) in hotArticles" :key="article.id" class="group flex items-start gap-6">

        <span class="flex-none text-sm font-mono font-medium text-[#D4D4D8] group-hover:text-[#2A599C] transition-colors duration-300 w-6 pt-0.5">
          {{ formatIndex(index) }}
        </span>

        <router-link
          :to="`/article/${article.id}`"
          class="flex-auto rounded-[8px] text-sm font-medium text-[#0F0F11] group-hover:text-[#2A599C] transition-colors duration-300 leading-relaxed line-clamp-2 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
        >
          {{ article.title }}
        </router-link>
        <p class="self-end text-xs text-[#A1A1AA] font-medium">
          {{ formatViews(article.views) }} Views
        </p>

      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { getHotArticles, type PopularArticleSummaryResponse } from '@/api/article'
import { useSseStore } from '@/store/sse'

const CONFIG = {
  MAX_ITEMS: 5,
  DEBOUNCE_MS: 500
}

const sseStore = useSseStore()

const hotArticles = ref<PopularArticleSummaryResponse[]>([])
const loading = ref(true)
const isError = ref(false)

let abortController: AbortController | null = null

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

const dispatchHotUpdate = () => {
  if (debounceTimer) clearTimeout(debounceTimer)

  debounceTimer = setTimeout(() => {
    loadHotArticles(false)
    debounceTimer = null
  }, CONFIG.DEBOUNCE_MS)
}

onMounted(() => {
  loadHotArticles();
})

watch(
  () => sseStore.articleRevision,
  () => {
    const shouldSync = sseStore.articleBatch.some((patch) => {
      if (patch.kind === 'reconnected') {
        return true
      }

      const action = patch.event?.payload.action
      return action === 'Created' || action === 'Deleted' || action === 'Restored'
    })

    if (shouldSync) {
      dispatchHotUpdate()
    }
  }
)

onUnmounted(() => {
  // 安全性保障：清理防抖任务与监听器
  if (abortController) abortController.abort()
  if (debounceTimer) clearTimeout(debounceTimer)
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
