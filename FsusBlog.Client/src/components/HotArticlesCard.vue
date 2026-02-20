<template>
  <section>
    <h2 class="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">
      热门文章
    </h2>
    
    <div v-if="loading" class="space-y-6 animate-pulse">
      <div v-for="i in 5" :key="i" class="flex gap-4">
        <div class="w-6 h-6 bg-zinc-100/80 mt-0.5"></div>
        <div class="flex-1 space-y-2.5 pt-1">
          <div class="h-3 bg-zinc-100/80 w-full"></div>
          <div class="h-3 bg-zinc-100/80 w-2/3"></div>
        </div>
      </div>
    </div>

    <ol v-else role="list" class="space-y-6">
      <li v-for="(article, index) in hotArticles" :key="article.id" class="group flex items-start gap-4">
        
        <span class="flex-none text-sm font-mono font-medium text-zinc-300 group-hover:text-zinc-950 transition-colors duration-300 w-6 pt-0.5">
          0{{ index + 1 }}
        </span>
        
        <div class="flex-auto flex flex-col gap-1.5">
          <router-link 
            :to="`/article/${article.id}`" 
            class="text-sm font-medium text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-relaxed line-clamp-2"
          >
            {{ article.title }}
          </router-link>
          
          <p class="text-xs text-zinc-400 font-medium tracking-tight">
            {{ article.views }} Views
          </p>
        </div>

      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { getHotArticles, type ArticleListItem } from '@/api/article'

const hotArticles = ref<ArticleListItem[]>([])
const loading = ref(true)

// 🌟 安全性保障：并发竞争校验
const lastEventTime = ref<number>(0)
// 🌟 性能最大化：防抖定时器
let debounceTimer: any = null

/**
 * 核心加载逻辑 (逻辑自洽：支持静默更新)
 */
const loadHotArticles = async (showLoading = true) => {
  if (showLoading) loading.value = true
  try {
    hotArticles.value = await getHotArticles(5)
  } catch (error) {
    console.error('[HotArticles] Sync failed:', error)
  } finally {
    loading.value = false
  }
}

/**
 * 🌟 热门列表防抖调度中心
 */
const dispatchHotUpdate = (eventTime: string) => {
  const eventTimestamp = new Date(eventTime).getTime();
  
  // 并发校验：仅处理最新的信令
  if (eventTimestamp <= lastEventTime.value) return;
  lastEventTime.value = eventTimestamp;

  if (debounceTimer) clearTimeout(debounceTimer);
  
  debounceTimer = setTimeout(() => {
    console.log("[SignalR] 执行热门文章静默同步...");
    loadHotArticles(false);
    debounceTimer = null;
  }, 500);
}

// 🌟 逻辑自洽：信号拦截器
const handleRemoteChange = (e: Event) => {
  const data = (e as CustomEvent).detail;
  // 无论是新增、更新还是删除，都可能影响热点排行，统一调度同步
  dispatchHotUpdate(data.eventTime);
}

// 🌟 断线重连同步
const handleSignalRReconnected = () => {
  loadHotArticles(false);
}

onMounted(() => {
  loadHotArticles();
  
  // 注册信令监听
  window.addEventListener('signalr:article-created', handleRemoteChange);
  window.addEventListener('signalr:article-updated', handleRemoteChange);
  window.addEventListener('signalr:article-deleted', handleRemoteChange);
  window.addEventListener('signalr:article-restored', handleRemoteChange);
  window.addEventListener('signalr:reconnected', handleSignalRReconnected);
})

onUnmounted(() => {
  // 安全性保障：清理防抖任务与监听器
  if (debounceTimer) clearTimeout(debounceTimer);
  
  window.removeEventListener('signalr:article-created', handleRemoteChange);
  window.removeEventListener('signalr:article-updated', handleRemoteChange);
  window.removeEventListener('signalr:article-deleted', handleRemoteChange);
  window.removeEventListener('signalr:article-restored', handleRemoteChange);
  window.removeEventListener('signalr:reconnected', handleSignalRReconnected);
})
</script>

<style scoped>
@reference "@/assets/main.css";
</style>