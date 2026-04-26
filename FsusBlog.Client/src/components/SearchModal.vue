<template>
  <Teleport to="body">
    <transition name="search-transition" @after-leave="handleAfterLeave">
      <div
        v-if="visible"
        id="search-modal-overlay"
        class="fixed inset-0 z-300 flex items-start justify-center pt-16 sm:pt-32 px-4 sm:px-6 overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-label"
      >
        <div
          class="absolute inset-0 bg-[var(--fsus-panel-bg)]/90 backdrop-blur-xl touch-none"
          @click.self="close"
        ></div>

        <div class="relative w-full max-w-2xl animate-in fade-in zoom-in-95 duration-300">

          <div class="relative border-b-2 border-[#0F0F11] pb-4">
            <input
              ref="searchInput"
              v-model="keyword"
              type="text"
              id="search-label"
              placeholder="键入以检索..."
              class="w-full bg-transparent text-2xl sm:text-4xl font-black tracking-normal text-[#0F0F11] placeholder:text-[#F4F4F5] outline-none appearance-none rounded-none"
              @input="handleInput"
              @keydown.esc="close"
              @keydown.enter="handleFullSearch"
              autocomplete="off"
            />
            <div class="static mt-3 flex flex-wrap items-center gap-3 sm:absolute sm:right-0 sm:bottom-5 sm:mt-0 sm:gap-6">
              <span v-if="powProvider.isCalculating.value" class="text-[10px] font-bold text-[#A1A1AA] animate-pulse uppercase tracking-normal">安全校验中...</span>
              <span v-else-if="loading" class="text-[10px] font-bold text-[#A1A1AA] animate-pulse uppercase tracking-normal">搜索中...</span>

              <span v-if="keyword && !loading && !powProvider.isCalculating.value" class="hidden sm:block text-[10px] font-bold text-[#D4D4D8] uppercase tracking-normal">Enter 全选</span>
              <button v-if="keyword" @click="clearSearch" class="text-[10px] font-bold text-[#D4D4D8] hover:text-[#2A599C] uppercase tracking-normal transition-colors">Clear</button>
            </div>
          </div>

          <div class="mt-10 max-h-[60vh] overflow-y-auto no-scrollbar pb-12">
            <transition-group name="list-fade-up">
              <div v-for="item in results" :key="item.id" class="group mb-8 last:mb-0">
                <router-link :to="{ name: 'ArticleDetail', params: { id: item.id } }" @click="close" class="block">
                  <div class="flex items-center gap-6 mb-2">
                    <span class="text-[10px] font-mono text-[#D4D4D8] uppercase shrink-0">
                      {{ TimeUtils.toSmartTime(item.createTime) }}
                    </span>
                    <div class="h-px grow bg-[#FCFCFC] group-hover:bg-[#E4E4E7] transition-colors"></div>
                  </div>
                  <h3
                    class="text-lg sm:text-xl font-bold text-[#71717A] group-hover:text-[#0F0F11] transition-colors leading-tight wrap-break-word overflow-hidden"
                    v-html="safeHighlight(item.title)"
                  ></h3>
                </router-link>
              </div>
            </transition-group>

            <div v-if="keyword && !loading && !powProvider.isCalculating.value && results.length === 0" class="py-10 animate-in fade-in duration-500">
              <p class="safe-inline-wrap text-[11px] font-mono text-[#D4D4D8] uppercase tracking-normal">没有匹配到相关内容。</p>
            </div>

            <div v-if="results.length > 0" class="pt-4">
              <button @click="handleFullSearch" class="min-h-11 text-[10px] font-black uppercase tracking-normal text-[#0F0F11] hover:opacity-60 transition-opacity">
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
import type { ArticleListItemResponse } from '@/api/article'
import { useSiteStore } from '@/store/site'
import { usePow } from '@/composables/usePow'
import { TimeUtils } from '@/utils/time'
import { loadSearchIndex, searchIndex } from '@/services/localSearch'
import { createHighlightedTrustedHtml, escapeRegExpLiteral, type TrustedHtml } from '@/utils/trustedHtml'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits(['update:visible'])

const router = useRouter()
const siteStore = useSiteStore()
const powProvider = usePow()

const keyword = ref('')
const results = ref<ArticleListItemResponse[]>([])
const loading = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let clearTimer: ReturnType<typeof setTimeout> | null = null
let abortController: AbortController | null = null

let previousActiveElement: HTMLElement | null = null

const highlightRegex = computed(() => {
  const q = keyword.value.trim()
  if (!q) return null
  try {
    const escaped = escapeRegExpLiteral(q)
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

const handleAfterLeave = () => {
  clearSearch()
}

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
    if (abortController) abortController.abort()
    abortController = new AbortController()
    const currentSignal = abortController.signal

    loading.value = true
    try {
      const res = await searchIndex(currentKeyword, 'relevance', 1, 5, currentSignal)

      if (!currentSignal.aborted) {
        results.value = Array.isArray(res.items) ? res.items.slice(0, 5) : []
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
  if (!q) return
  router.push({ path: '/search', query: { q } })
  close()
}

const safeHighlight = (text: string): TrustedHtml => {
  return createHighlightedTrustedHtml(text, highlightRegex.value, 'bg-[#F4F4F5] text-[#0F0F11] px-0.5')
}

watch(() => props.visible, (newVal) => {
  if (newVal) {
    void loadSearchIndex().catch((error) => {
      console.error('[Search Index Load Fail]', error)
    })
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
