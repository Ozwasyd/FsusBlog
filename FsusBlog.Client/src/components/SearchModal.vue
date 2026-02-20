<template>
  <Teleport to="body">
    <transition name="search-transition">
      <div 
        v-if="visible" 
        class="fixed inset-0 z-300 flex items-start justify-center pt-20 sm:pt-32 px-6 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-label"
      >
        <div class="absolute inset-0 bg-white/90 backdrop-blur-xl touch-none" @click="close"></div>

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
              <span v-if="isCalculating" class="text-[10px] font-bold text-zinc-400 animate-pulse uppercase tracking-widest">安全校验中...</span>
              <span v-else-if="loading" class="text-[10px] font-bold text-zinc-400 animate-pulse uppercase tracking-widest">搜索中...</span>
              
              <span v-if="keyword && !loading && !isCalculating" class="hidden sm:block text-[10px] font-bold text-zinc-300 uppercase tracking-widest">Enter 全选</span>
              <button v-if="keyword" @click="clearSearch" class="text-[10px] font-bold text-zinc-300 hover:text-zinc-950 uppercase tracking-widest transition-colors">Clear</button>
            </div>
          </div>

          <div class="mt-10 max-h-[60vh] overflow-y-auto no-scrollbar pb-12">
            <transition-group name="list-fade-up">
              <div v-for="item in results" :key="item.id" class="group mb-8 last:mb-0">
                <router-link :to="`/article/${item.id}`" @click="close" class="block">
                  <div class="flex items-center gap-4 mb-2">
                    <span class="text-[10px] font-mono text-zinc-300 uppercase shrink-0">{{ formatDate(item.createTime) }}</span>
                    <div class="h-px grow bg-zinc-50 group-hover:bg-zinc-200 transition-colors"></div>
                  </div>
                  <h3 
                    class="text-lg sm:text-xl font-bold text-zinc-600 group-hover:text-zinc-950 transition-colors leading-tight wrap-break-word overflow-hidden"
                    v-html="safeHighlight(item.title)"
                  ></h3>
                </router-link>
              </div>
            </transition-group>

            <div v-if="keyword && !loading && !isCalculating && results.length === 0" class="py-10 animate-in fade-in duration-500">
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
import { ref, watch, nextTick, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { searchArticles, type ArticleListItem } from '@/api/article'
import { getPowChallenge } from '@/api/auth'
import { getBrowserFp } from '@/utils/fingerprint'
import { usePow } from '@/composables/usePow'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits(['update:visible'])

const router = useRouter()
const { calculate, isCalculating, prewarm } = usePow()

const keyword = ref('')
const results = ref<ArticleListItem[]>([])
const loading = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)

let timer: any = null

const close = () => emit('update:visible', false)

const clearSearch = () => {
  keyword.value = ''
  results.value = []
}

/**
 * 核心检索流水线：挑战获取 -> 算力求解 -> 加固请求
 * 安全性保障：针对 403 错误实现递归算力重试
 */
const performSearch = async (keywordStr: string, retryCount = 0): Promise<ArticleListItem[]> => {
  try {
    // 1. 获取 PoW 挑战
    const challengeRes = await getPowChallenge({ action: 'search' });
    const { salt, difficulty, timestamp, signature } = challengeRes as any;

    // 2. 算力求解 (利用 Worker 独立线程)
    const fp = getBrowserFp();
    const { nonce } = await calculate(salt, fp, difficulty);

    // 3. 执行加固后的检索请求
    const res = await searchArticles({
      keyword: keywordStr,
      powSalt: salt,
      powNonce: nonce,
      powTimestamp: timestamp,
      difficulty: difficulty,
      powSignature: signature,
      browserFp: fp
    });

    const rawData = (res as any).data ?? res;
    return Array.isArray(rawData) ? rawData : [];
  } catch (err: any) {
    // 处理难度熔断升级逻辑
    if (err.response?.status === 403 && retryCount < 1) {
      console.warn("[Search PoW] 难度提升，正在重试...");
      return performSearch(keywordStr, retryCount + 1);
    }
    throw err;
  }
}

/**
 * 调度中心：处理防抖与竞态检查
 */
const handleInput = () => {
  if (timer) clearTimeout(timer)
  const currentTrimmed = keyword.value.trim()
  
  if (!currentTrimmed) {
    results.value = []
    loading.value = false
    return
  }
  
  timer = setTimeout(async () => {
    loading.value = true
    try {
      const list = await performSearch(currentTrimmed)
      
      // 竞态检查：确保请求返回时用户未更改关键词
      if (keyword.value.trim() !== currentTrimmed) return

      results.value = list.slice(0, 5)
    } catch (err) {
      console.error('[Search Fail]', err)
      results.value = []
    } finally {
      loading.value = false
    }
  }, 400) // 考虑到算力开销，防抖时间微调至 400ms 减少无效计算
}

const handleFullSearch = () => {
  if (!keyword.value.trim() || isCalculating.value) return
  router.push({ path: '/search', query: { q: keyword.value.trim() } })
  close()
}

/**
 * XSS 安全高亮逻辑
 */
const safeHighlight = (text: string) => {
  if (!text) return ''
  let sanitized = text.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  
  const query = keyword.value.trim()
  if (!query) return sanitized

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  return sanitized.replace(regex, '<mark class="bg-zinc-100 text-zinc-950 px-0.5">$1</mark>')
}

const formatDate = (date: string) => {
  const d = new Date(date)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * 监听器：处理焦点与滚动锁定
 */
watch(() => props.visible, (newVal) => {
  if (newVal) {
    // 预热 WASM 引擎，性能最大化
    prewarm()
    nextTick(() => searchInput.value?.focus())
    document.body.style.setProperty('overflow', 'hidden')
  } else {
    document.body.style.removeProperty('overflow')
    setTimeout(clearSearch, 400)
  }
})

onUnmounted(() => {
  if (timer) clearTimeout(timer)
  document.body.style.removeProperty('overflow')
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
</style>