<template>
  <Teleport to="body">
    <transition name="modal-fade" @after-leave="handleAfterLeave">
      <div
        v-if="visible"
        id="policy-modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-modal-title"
        class="fixed inset-0 z-350 flex items-end sm:items-center justify-center p-6 sm:p-6 overflow-hidden"
        @keydown="handleTabKey"
      >
        <div
          class="absolute inset-0 bg-[var(--fsus-panel-bg)]/80 backdrop-blur-md transition-opacity duration-500 touch-none"
          @click="close"
        ></div>

        <div
          ref="modalContainer"
          class="relative w-full max-w-3xl border border-[#E4E4E7] bg-[var(--fsus-panel-bg)]/90 shadow-[0_32px_64px_rgba(0,0,0,0.08)] backdrop-blur-[32px] flex flex-col h-auto max-h-[85vh] rounded-[24px] animate-in slide-in-from-bottom-4 fade-in duration-300"
        >

          <header class="flex items-center justify-between px-5 py-4 sm:px-8 sm:py-6 border-b border-[#F4F4F5] shrink-0 select-none">
            <div class="flex flex-col">
              <h2 id="policy-modal-title" class="text-lg sm:text-xl font-bold tracking-normal text-[#0F0F11] font-sans">
                {{ titleMap[type] || '条款详情' }}
              </h2>
            </div>

            <button
              type="button"
              @click="close"
              class="group w-9 h-9 sm:w-10 sm:h-10 -mr-2 flex items-center justify-center rounded-[8px] bg-[#FCFCFC] sm:bg-transparent border border-transparent sm:border-[#E4E4E7] hover:border-[#2A599C] hover:bg-[#2A599C] transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]"
              aria-label="关闭对话框"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-[#A1A1AA] group-hover:text-white transition-colors">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </header>

          <div
            class="flex-1 overflow-y-auto p-5 sm:p-12 overscroll-contain scrollbar-thin scrollbar-thumb-[#E4E4E7] scrollbar-track-transparent relative"
            :aria-busy="loading"
            role="document"
          >

            <div v-if="loading" class="flex flex-col items-center justify-center h-48 space-y-4 opacity-50" role="status">
              <div class="w-6 h-6 border-2 border-[#E4E4E7] border-t-[#0F0F11] rounded-[999px] animate-spin"></div>
              <span class="sr-only">正在加载内容...</span>
            </div>

            <div v-else-if="error" class="flex flex-col items-center justify-center h-40">
              <p class="text-sm font-medium text-[#A1A1AA]">无法加载文档内容</p>
              <button type="button" @click="fetchData" class="mt-2 text-xs font-bold underline hover:text-[#2A599C] outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">重试</button>
            </div>

            <div v-else class="fsus-legal-doc font-sans selection:bg-[#0F0F11] selection:text-white" v-html="renderedContent"></div>

          </div>

          <footer class="p-5 sm:p-6 border-t border-[#F4F4F5] bg-[var(--fsus-panel-bg)]/50 backdrop-blur flex justify-end items-center shrink-0 rounded-b-2xl">
            <button
              type="button"
              ref="confirmBtn"
              @click="close"
              class="w-full sm:w-auto px-10 py-3.5 sm:py-3 bg-[#0F0F11] text-white text-xs font-bold tracking-normal uppercase hover:bg-[#2A599C] transition-colors rounded-[8px] active:scale-[0.98] outline-none focus:ring-2 focus:ring-[#2A599C] focus:ring-offset-2"
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
import { renderMarkdownDocument } from '@/services/markdownRenderHost'
import { useSiteStore } from '@/store/site'
import { EMPTY_TRUSTED_HTML, trustStaticHtml, type TrustedHtml } from '@/utils/trustedHtml'

const props = defineProps<{
  visible: boolean,
  type: 'privacy' | 'guidelines'
}>()

const emit = defineEmits<{ (e: 'update:visible', value: boolean): void }>()

const siteStore = useSiteStore()

const titleMap: Record<string, string> = {
  privacy: '隐私政策',
  guidelines: '用户守则'
}

const renderedContent = ref<TrustedHtml>(EMPTY_TRUSTED_HTML)
const loading = ref(false)
const error = ref(false)
const loadedType = ref('')

const modalContainer = ref<HTMLElement | null>(null)
const confirmBtn = ref<HTMLButtonElement | null>(null)
let previousActiveElement: HTMLElement | null = null
let abortController: AbortController | null = null

const close = () => emit('update:visible', false)

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
        const result = await renderMarkdownDocument({
          source: rawContent,
          mode: 'about',
          allowHtml: false,
          allowLatex: true,
          allowMermaid: true
        })
        renderedContent.value = result.html
        loadedType.value = props.type
      } else {
        renderedContent.value = trustStaticHtml(`<p class="text-[#A1A1AA]">暂未配置${titleMap[props.type]}。</p>`)
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

const handleTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !modalContainer.value) return;

    const focusables = modalContainer.value.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

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

/* =======================================================
   法务公文级排版引擎 (Legal Document Typography)
   核心要求：严谨、清晰的层级、紧凑但不拥挤、去除花哨装饰
======================================================= */

.fsus-legal-doc {
  color: #27272a;
  font-size: 0.95rem;
  line-height: 1.7;
  letter-spacing: 0;
  text-align: left;
  text-autospace: ideograph-alpha ideograph-numeric;
  text-spacing-trim: space-all;
}

/* 消除顶部元素的无意义边距 */
.fsus-legal-doc :deep(*:first-child) { margin-top: 0 !important; }

/* 1. 标题层级重构 (Headings) */
.fsus-legal-doc :deep(h1),
.fsus-legal-doc :deep(h2),
.fsus-legal-doc :deep(h3),
.fsus-legal-doc :deep(h4) {
  color: #09090b;
  font-weight: 700;
  text-indent: 0;
  margin-bottom: 0.8em;
}

/* 协议主标题 */
.fsus-legal-doc :deep(h1) {
  font-size: 1.5em;
  margin-top: 2em;
  text-align: left;
  border-bottom: 2px solid #18181b;
  padding-bottom: 0.5em;
  margin-bottom: 1.5em;
}

/* 条款大类 (如：一、数据收集) */
.fsus-legal-doc :deep(h2) {
  font-size: 1.15em;
  margin-top: 2.5em;
  border-bottom: 1px solid #e4e4e7;
  padding-bottom: 0.4em;
}

/* 具体细则条款 */
.fsus-legal-doc :deep(h3) {
  font-size: 1em;
  margin-top: 1.8em;
}

/* 2. 段落节律 (Paragraphs) */
.fsus-legal-doc :deep(p) {
  margin-top: 0;
  margin-bottom: 0.8em;
  text-indent: 0;
}

/* 3. 有序编号体系 (Lists & Indentation)
   法务文档极其依赖清晰的缩进结构（如 1.1, 1.1.1）
*/
.fsus-legal-doc :deep(ol),
.fsus-legal-doc :deep(ul) {
  padding-left: 1.8em;
  margin-top: 0.5em;
  margin-bottom: 1.2em;
}

.fsus-legal-doc :deep(li) {
  margin-bottom: 0.4em;
  padding-left: 0.2em;
}

.fsus-legal-doc :deep(li p) {
  margin-bottom: 0 !important;
  margin-top: 0.2em;
}

/* 4. 关键信息强调 (Strong & Emphasis) */
.fsus-legal-doc :deep(strong) {
  font-weight: 700;
  color: #0f0f11;
  background-color: #f4f4f5;
  padding: 0 0.2em;
  border-radius: 2px;
}

/* 5. 引用块 (Blockquotes - 常用于定义或免责声明) */
.fsus-legal-doc :deep(blockquote) {
  border-left: 3px solid #71717a;
  margin: 1.5em 0 !important;
  padding: 0.8em 1.2em !important;
  color: #52525b !important;
  background-color: #fafafa !important;
  font-size: 0.9em;
  font-weight: 500;
}

.fsus-legal-doc :deep(blockquote p) {
  margin-bottom: 0.5em;
}
.fsus-legal-doc :deep(blockquote p:last-child) {
  margin-bottom: 0;
}

/* 6. 超链接 */
.fsus-legal-doc :deep(a) {
  color: #2a599c;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: opacity 0.2s ease;
}
.fsus-legal-doc :deep(a:hover) {
  color: #0f0f11;
}

.no-scrollbar::-webkit-scrollbar { display: none; }
</style>
