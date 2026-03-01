<template>
  <Teleport to="body">
    <transition name="modal-fade" @after-leave="handleAfterLeave">
      <div 
        v-if="visible" 
        id="policy-modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-modal-title"
        class="fixed inset-0 z-350 flex items-end sm:items-center justify-center p-4 sm:p-6 overflow-hidden"
        @keydown="handleTabKey"
      >
        <!-- 背景遮罩 -->
        <div 
          class="absolute inset-0 bg-white/80 backdrop-blur-md transition-opacity duration-500 touch-none" 
          @click="close"
        ></div>

        <div 
          ref="modalContainer"
          class="relative w-full max-w-3xl bg-white border border-zinc-200 shadow-2xl shadow-zinc-200/50 flex flex-col h-auto max-h-[85vh] rounded-2xl animate-in slide-in-from-bottom-4 fade-in duration-300"
        >
          
          <header class="flex items-center justify-between px-5 py-4 sm:px-8 sm:py-6 border-b border-zinc-100 shrink-0 select-none">
            <div class="flex flex-col">
              <h2 id="policy-modal-title" class="text-lg sm:text-xl font-bold tracking-tight text-zinc-950 font-sans">
                {{ titleMap[type] || '条款详情' }}
              </h2>
            </div>
            
            <button 
              type="button"
              @click="close" 
              class="group w-9 h-9 sm:w-10 sm:h-10 -mr-2 flex items-center justify-center rounded-full bg-zinc-50 sm:bg-transparent border border-transparent sm:border-zinc-200 hover:border-zinc-950 hover:bg-zinc-950 transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950"
              aria-label="关闭对话框"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-400 group-hover:text-white transition-colors">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </header>

          <div 
            class="flex-1 overflow-y-auto p-5 sm:p-12 overscroll-contain scrollbar-thin scrollbar-thumb-zinc-200 scrollbar-track-transparent relative"
            :aria-busy="loading"
            role="document"
          >
            
            <div v-if="loading" class="flex flex-col items-center justify-center h-48 space-y-4 opacity-50" role="status">
              <div class="w-6 h-6 border-2 border-zinc-200 border-t-zinc-950 rounded-full animate-spin"></div>
              <span class="sr-only">正在加载内容...</span>
            </div>

            <div v-else-if="error" class="flex flex-col items-center justify-center h-40">
              <p class="text-sm font-medium text-zinc-400">无法加载文档内容</p>
              <button type="button" @click="fetchData" class="mt-2 text-xs font-bold underline hover:text-zinc-950 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950">重试</button>
            </div>

            <div v-else class="zinc-doc font-sans selection:bg-zinc-950 selection:text-white" v-html="renderedContent"></div>

          </div>

          <footer class="p-5 sm:p-6 border-t border-zinc-100 bg-white/50 backdrop-blur flex justify-end items-center shrink-0 rounded-b-2xl">
            <button 
              type="button"
              ref="confirmBtn"
              @click="close" 
              class="w-full sm:w-auto px-10 py-3.5 sm:py-3 bg-zinc-950 text-white text-xs font-bold tracking-widest uppercase hover:opacity-90 transition-opacity rounded-lg sm:rounded-sm shadow-lg shadow-zinc-950/20 active:scale-[0.98] outline-none focus:ring-2 focus:ring-zinc-950 focus:ring-offset-2"
            >
              我已阅读
            </button>
          </footer>

        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, nextTick } from 'vue'
import { getPageData } from '@/api/system'
import { useSiteStore } from '@/store/site'
import MarkdownIt from 'markdown-it'

const props = defineProps<{ 
  visible: boolean,
  type: 'privacy' | 'guidelines'
}>()

const emit = defineEmits<{ (e: 'update:visible', value: boolean): void }>()

const siteStore = useSiteStore()

// 性能最大化：单例实例化解析引擎
const md = new MarkdownIt({ 
  html: false, 
  breaks: true, 
  linkify: true 
});

/**
 * 安全策略插件
 */
md.validateLink = (url: string) => {
    return /^(https?|mailto|tel):/i.test(url);
};

const originalRender = md.renderer.rules.link_open || function(tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    // [修复 2026-02-23] 修复 TS 2532: 显式类型检查，确保索引访问安全
    const token = tokens[idx];
    if (token) {
        token.attrPush(['rel', 'noopener noreferrer']);
        token.attrPush(['target', '_blank']);
    }
    return originalRender(tokens, idx, options, env, self);
};

const titleMap: Record<string, string> = {
  privacy: '隐私政策',
  guidelines: '用户守则'
}

const renderedContent = ref('')
const loading = ref(false)
const error = ref(false)
const loadedType = ref('') 

// 引用管理
const modalContainer = ref<HTMLElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
let previousActiveElement: HTMLElement | null = null
let abortController: AbortController | null = null

const close = () => emit('update:visible', false)

/**
 * 核心加载逻辑
 */
const fetchData = async () => {
  if (abortController) abortController.abort()
  abortController = new AbortController()
  const currentSignal = abortController.signal

  loading.value = true
  error.value = false

  try {
    const res = await getPageData(props.type, { signal: currentSignal })
    
    if (!currentSignal.aborted) {
      const rawContent = (res as any)?.data?.content || (res as any)?.content || ''
      if (rawContent) {
        renderedContent.value = md.render(rawContent)
        loadedType.value = props.type
      } else {
        renderedContent.value = `<p class="text-zinc-400">暂未配置${titleMap[props.type]}。</p>`
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.error('[PolicyModal] Fetch failed:', err)
      error.value = true
    }
  } finally {
    abortController = null
    if (!currentSignal.aborted) loading.value = false
  }
}

/**
 * [修复 2026-02-23] 修复 TS 18048: 显式验证元素存在性
 * 算法最优：通过逻辑与短路判断，物理保证 first 和 last 不为 undefined
 */
const handleTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !modalContainer.value) return;

    const focusables = modalContainer.value.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    // 逻辑自洽：如果弹窗内没有可聚焦元素，或者索引失效，则不执行循环逻辑
    if (!first || !last) return;

    if (e.shiftKey) {
        if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
        }
    } else {
        if (document.activeElement === last) {
            first.focus();
            e.preventDefault();
        }
    }
};

const handleAfterLeave = () => {
  if (loadedType.value !== props.type) {
    renderedContent.value = ''
    loadedType.value = ''
  }
}

const handleGlobalKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && props.visible) close()
}

watch(() => props.visible, (newVal) => {
  if (newVal) {
    previousActiveElement = document.activeElement as HTMLElement
    siteStore.lockScroll()
    window.addEventListener('keydown', handleGlobalKeyDown)

    if (loadedType.value !== props.type) {
      fetchData()
    }
    nextTick(() => confirmBtn.value?.focus())
  } else {
    siteStore.unlockScroll()
    window.removeEventListener('keydown', handleGlobalKeyDown)
    if (previousActiveElement) {
        nextTick(() => previousActiveElement?.focus())
    }
  }
})

onUnmounted(() => {
  if (abortController) abortController.abort()
  window.removeEventListener('keydown', handleGlobalKeyDown)
  siteStore.forceUnlockScroll()
})
</script>

<style scoped>
@reference "@/assets/main.css";

.modal-fade-enter-active, .modal-fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.modal-fade-enter-from, .modal-fade-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.98);
}

.zinc-doc :deep(h1),
.zinc-doc :deep(h2),
.zinc-doc :deep(h3) {
  @apply font-bold text-zinc-950 tracking-tight mt-6 sm:mt-10 mb-4 flex items-baseline;
}
.zinc-doc :deep(h1) { 
  @apply text-xl sm:text-4xl border-b border-zinc-100 pb-4 sm:pb-6 mb-6; 
}
.zinc-doc :deep(h3) { 
  @apply text-base sm:text-xl;
}
.zinc-doc :deep(h3)::before {
  content: '';
  @apply inline-block w-1.5 h-1.5 sm:w-2 sm:h-2 bg-zinc-200 mr-2 sm:mr-3 rounded-full mb-0.5;
}
.zinc-doc :deep(*:first-child) { @apply mt-0; }
.zinc-doc :deep(p) {
  @apply text-[13px] sm:text-[15px] leading-relaxed sm:leading-7 text-zinc-600 mb-5 text-justify font-normal;
}
.zinc-doc :deep(ul) { @apply ml-1 mb-6 space-y-2; }
.zinc-doc :deep(li) {
  @apply text-[12px] sm:text-[14px] text-zinc-600 pl-4 sm:pl-6 relative;
}
.zinc-doc :deep(li)::before {
  content: '—';
  @apply absolute left-0 text-zinc-300 font-bold;
}
.zinc-doc :deep(strong) {
  @apply font-bold text-zinc-950;
}
.zinc-doc :deep(blockquote) {
  @apply border-l-4 border-zinc-100 pl-4 sm:pl-6 py-2 my-6 text-zinc-500 italic text-[12px] sm:text-[14px];
}
.zinc-doc :deep(a) {
  @apply text-zinc-950 font-medium underline decoration-zinc-200 underline-offset-4 decoration-1 hover:decoration-zinc-950 transition-all;
}

.no-scrollbar::-webkit-scrollbar { display: none; }
</style>