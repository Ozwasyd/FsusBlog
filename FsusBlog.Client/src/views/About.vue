<template>
  <div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen flex flex-col">
    
    <!-- 骨架屏：物理比例对齐，减少布局抖动 -->
    <div v-if="loading" class="animate-pulse space-y-8 py-8" aria-hidden="true">
      <div class="h-8 sm:h-12 bg-zinc-100 w-2/3"></div> 
      <div class="flex gap-4">
        <div class="h-4 bg-zinc-100 w-24"></div> 
      </div>
      <div class="space-y-4 pt-8 sm:pt-12">
        <div v-for="i in 5" :key="i" class="h-4 bg-zinc-100 w-full"></div>
      </div>
    </div>

    <article v-else-if="!error" class="animate-in fade-in slide-in-from-bottom-4 duration-700 grow">
      
      <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
        <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6 tracking-tighter">
          关于
        </h1>
        
        <div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
          <time>{{ new Date().getFullYear() }}</time>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span class="text-zinc-600 font-medium tracking-[0.05em]">MANIFESTO</span>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span>README.MD</span>
        </div>
      </header>

      <!-- [修复 2026-02-24] 架构演进：使用独立的渲染引擎组件，剥离渲染脏活 -->
      <MarkdownRenderer 
        :content="rawMarkdown" 
      />

      <footer class="mt-24 pt-10 border-t border-zinc-100 mb-20 flex justify-between items-center opacity-80 hover:opacity-100 transition-opacity">
        <div class="flex flex-col gap-1">
          <span class="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-950">
            {{ siteStore.siteInfo.title }}
          </span>
        </div>
      </footer>

    </article>

    <div v-else class="py-32 text-center grow flex flex-col items-center justify-center">
      <p class="text-xs font-mono font-medium tracking-widest uppercase text-zinc-400 mb-6">
        连接丢失。
      </p>
      <button 
        type="button"
        @click="fetchData" 
        class="text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 border-b border-zinc-950 pb-0.5 hover:text-zinc-500 hover:border-zinc-500 transition-all outline-none"
      >
        重连
      </button>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { getPageData } from '@/api/system'
import { useSiteStore } from '@/store/site'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'

const siteStore = useSiteStore()

// ==========================================
// 1. 状态与副作用管理
// ==========================================

const rawMarkdown = ref('') // [修复 2026-02-24] 仅存储原始 Markdown 内容
const loading = ref(true)
const error = ref(false)

// [修复 2026-02-24] P0 修复：引入物理中断快照，防止路由切换后的幽灵写入
let abortController: AbortController | null = null

/**
 * 数据抓取逻辑
 */
const fetchData = async () => {
  if (abortController) abortController.abort()
  const currentController = new AbortController()
  abortController = currentController
  const { signal } = currentController

  loading.value = true
  error.value = false
  
  try {
    const res = await getPageData('about', { signal })
    
    // 竞态检查：确保只有当前有效的请求能更新状态
    if (!signal.aborted) {
      // 逻辑自洽：兼容多层级数据结构，并提供内容兜底
      const content = (res as any).data?.content || (res as any).content || ''
      rawMarkdown.value = content || '> 暂无介绍内容。'
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && !signal.aborted) {
      console.error('[About] Fetch failed:', err.message)
      error.value = true
    }
  } finally {
    // 物理真相：仅在当前请求是“最后赢家”时才置空全局控制器
    if (abortController === currentController) {
      loading.value = false
      abortController = null
    }
  }
}

onMounted(() => {
  fetchData()
})

onUnmounted(() => {
  // 安全性保障：组件卸载时物理切断正在进行的网络请求
  if (abortController) abortController.abort()
})
</script>

<style scoped>
@reference "@/assets/main.css";
/* 
  所有关于 .prose, .shiki 的样式已迁移至 MarkdownRenderer.vue 
  此处仅保留 About 页面特有的布局微调
*/
</style>