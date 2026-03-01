<template>
  <Teleport to="body">
    <transition name="search-transition" @after-leave="handleAfterLeave">
      <div 
        v-if="visible" 
        id="search-modal-overlay"
        class="fixed inset-0 z-300 flex items-start justify-center pt-20 sm:pt-32 px-6 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-label"
      >
        <!-- 背景遮罩：使用 .self 修饰符确保仅点击背景触发关闭，防止子元素点击穿透 -->
        <div 
          class="absolute inset-0 bg-white/90 backdrop-blur-xl touch-none" 
          @click.self="close"
        ></div>

        <div class="relative w-full max-w-2xl animate-in fade-in zoom-in-95 duration-300">
          
          <div class="relative border-b-2 border-zinc-950 pb-4">
            <input 
              ref="searchInput"
              v-model="keyword"
              type="text"
              id="search-label"
              placeholder="键入以检索..."
              class="w-full bg-transparent text-2xl sm:text-4xl font-black tracking-tighter text-zinc-950 placeholder:text-zinc-100 outline-none appearance-none rounded-none"
              @input="handleInput"
              @keydown.esc="close"
              @keydown.enter="handleFullSearch"
              autocomplete="off"
            />
            <div class="absolute right-0 bottom-5 flex items-center gap-4">
              <!-- 逻辑自洽：由后端拦截器执行 PoW，此处仅通过 powProvider 监听计算状态 -->
              <span v-if="powProvider.isCalculating.value" class="text-[10px] font-bold text-zinc-400 animate-pulse uppercase tracking-widest">安全校验中...</span>
              <span v-else-if="loading" class="text-[10px] font-bold text-zinc-400 animate-pulse uppercase tracking-widest">搜索中...</span>
              
              <span v-if="keyword && !loading && !powProvider.isCalculating.value" class="hidden sm:block text-[10px] font-bold text-zinc-300 uppercase tracking-widest">Enter 全选</span>
              <button v-if="keyword" @click="clearSearch" class="text-[10px] font-bold text-zinc-300 hover:text-zinc-950 uppercase tracking-widest transition-colors">Clear</button>
            </div>
          </div>

          <div class="mt-10 max-h-[60vh] overflow-y-auto no-scrollbar pb-12">
            <transition-group name="list-fade-up">
              <div v-for="item in results" :key="item.id" class="group mb-8 last:mb-0">
                <router-link :to="{ name: 'ArticleDetail', params: { id: item.id } }" @click="close" class="block">
                  <div class="flex items-center gap-4 mb-2">
                    <span class="text-[10px] font-mono text-zinc-300 uppercase shrink-0">
                      {{ TimeUtils.toSmartTime(item.createTime) }}
                    </span>
                    <div class="h-px grow bg-zinc-50 group-hover:bg-zinc-200 transition-colors"></div>
                  </div>
                  <h3 
                    class="text-lg sm:text-xl font-bold text-zinc-600 group-hover:text-zinc-950 transition-colors leading-tight wrap-break-word overflow-hidden"
                    v-html="safeHighlight(item.title)"
                  ></h3>
                </router-link>
              </div>
            </transition-group>

            <div v-if="keyword && !loading && !powProvider.isCalculating.value && results.length === 0" class="py-10 animate-in fade-in duration-500">
              <p class="text-[11px] font-mono text-zinc-300 uppercase tracking-[0.2em]">没有匹配到相关内容。</p>
            </div>
            
            <div v-if="results.length > 0" class="pt-4">
              <button @click="handleFullSearch" class="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-950 hover:opacity-60 transition-opacity">
                查看全部结果 →
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { searchArticles, type ArticleListItem } from '@/api/article'
import { useSiteStore } from '@/store/site'
import { usePow } from '@/composables/usePow'
import { TimeUtils } from '@/utils/time'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits(['update:visible'])

const router = useRouter()
const siteStore = useSiteStore()
const powProvider = usePow()

const keyword = ref('')
const results = ref<ArticleListItem[]>([])
const loading = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)

// 算法最优：建立局部引用快照，彻底隔离并发竞态
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let clearTimer: ReturnType<typeof setTimeout> | null = null
let abortController: AbortController | null = null

// [修复 2026-02-23] 聚焦还原机制：保存打开前的活动元素
let previousActiveElement: HTMLElement | null = null

// 静态 HTML 转义映射表
const HTML_ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#47;', '`': '&#96;'
}

/**
 * [修复 2026-02-23] 性能最大化：预计算高亮正则
 * 逻辑自洽：仅在关键词变更时重建正则，消除 render 阶段的热路径开销
 */
const highlightRegex = computed(() => {
  const q = keyword.value.trim()
  if (!q) return null
  try {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(${escaped})`, 'gi')
  } catch (e) {
    return null
  }
})

const close = () => emit('update:visible', false)

const clearSearch = () => {
  keyword.value = ''
  results.value = []
  if (abortController) {
    abortController.abort()
    abortController = null
  }
}

/**
 * [修复 2026-02-23] 动画回调：在退出动画结束后清理状态
 */
const handleAfterLeave = () => {
  clearSearch()
}

/**
 * 调度中心：处理防抖与物理中断
 */
const handleInput = () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  
  const currentKeyword = keyword.value.trim()
  if (!currentKeyword) {
    results.value = []
    loading.value = false
    if (abortController) abortController.abort()
    return
  }
  
  debounceTimer = setTimeout(async () => {
    // [修复 2026-02-23] 竞态防护：物理中断旧请求并建立闭包快照
    if (abortController) abortController.abort()
    abortController = new AbortController()
    const currentSignal = abortController.signal

    loading.value = true
    try {
      // 逻辑自洽：不再手动调用 PoW 握手，透传标记给底层拦截器
      const res = await searchArticles(
        { keyword: currentKeyword }, 
        { signal: currentSignal }
      )
      
      // 竞态校验：仅在信号未取消且仍为当前控制器时写入
      if (!currentSignal.aborted) {
        const rawData = (res as any).data ?? res
        results.value = Array.isArray(rawData) ? rawData.slice(0, 5) : []
      }
    } catch (err: any) {
      if (err.name !== 'AbortError' && !currentSignal.aborted) {
        console.error('[Search Fail]', err)
        results.value = []
      }
    } finally {
      if (!currentSignal.aborted) {
        loading.value = false
        abortController = null
      }
    }
  }, 400) 
}

const handleFullSearch = () => {
  const q = keyword.value.trim()
  if (!q || powProvider.isCalculating.value) return
  router.push({ path: '/search', query: { q } })
  close()
}

/**
 * [修复 2026-02-23] XSS 安全高亮模型
 * 逻辑自洽：先执行严格的白名单字符替换，再注入高亮标签
 */
const safeHighlight = (text: string) => {
  if (!text) return ''
  // 物理级转义
  const sanitized = text.replace(/[&<>"'`\/]/g, m => HTML_ESCAPE_MAP[m] ?? m)
  
  const regex = highlightRegex.value
  if (!regex) return sanitized

  // 算法最优：利用捕获组保持原始大小写，并注入 mark 标签
  return sanitized.replace(regex, '<mark class="bg-zinc-100 text-zinc-950 px-0.5">$1</mark>')
}

/**
 * 监听器：处理 A11y 聚焦管理与滚动锁
 * [修复 2026-02-23] 物理还原：关闭时将焦点还给触发元素
 */
watch(() => props.visible, (newVal) => {
  if (newVal) {
    powProvider.prewarm()
    previousActiveElement = document.activeElement as HTMLElement
    nextTick(() => searchInput.value?.focus())
    siteStore.lockScroll()
  } else {
    siteStore.unlockScroll()
    if (previousActiveElement) {
        nextTick(() => previousActiveElement?.focus())
    }
  }
})

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (clearTimer) clearTimeout(clearTimer)
  if (abortController) abortController.abort()
  siteStore.forceUnlockScroll()
})
</script>

<style scoped>
@reference "@/assets/main.css";

.search-transition-enter-active,
.search-transition-leave-active {
  transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.search-transition-enter-from,
.search-transition-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.98);
}

.no-scrollbar::-webkit-scrollbar { display: none; }

.list-fade-up-enter-active { transition: all 0.4s ease-out; }
.list-fade-up-enter-from { opacity: 0; transform: translateY(10px); }

.wrap-break-word {
  overflow-wrap: break-word;
  word-break: break-word;
}
</style>