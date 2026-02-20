<template>
  <Teleport to="body">
    <transition name="modal-fade">
      <div v-if="visible" class="fixed inset-0 z-999 flex items-end sm:items-center justify-center p-4 sm:p-6 overflow-hidden">
        
        <div 
          class="absolute inset-0 bg-white/80 backdrop-blur-md transition-opacity duration-500 touch-none" 
          @click="close"
        ></div>

        <div class="relative w-full max-w-3xl bg-white border border-zinc-200 shadow-2xl shadow-zinc-200/50 flex flex-col h-auto max-h-[85vh] rounded-2xl animate-in slide-in-from-bottom-4 fade-in duration-300">
          
          <header class="flex items-center justify-between px-5 py-4 sm:px-8 sm:py-6 border-b border-zinc-100 shrink-0 select-none">
            <div class="flex flex-col">
              <h2 class="text-lg sm:text-xl font-bold tracking-tight text-zinc-950 font-sans">
                {{ titleMap[type] || '条款详情' }}
              </h2>
            </div>
            
            <button 
              @click="close" 
              class="group w-9 h-9 sm:w-10 sm:h-10 -mr-2 flex items-center justify-center rounded-full bg-zinc-50 sm:bg-transparent border border-transparent sm:border-zinc-200 hover:border-zinc-950 hover:bg-zinc-950 transition-all duration-300"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-400 group-hover:text-white transition-colors">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </header>

          <div class="flex-1 overflow-y-auto p-5 sm:p-12 overscroll-contain scrollbar-thin scrollbar-thumb-zinc-200 scrollbar-track-transparent relative">
            
            <div v-if="loading" class="flex flex-col items-center justify-center h-48 space-y-4 opacity-50">
              <div class="w-6 h-6 border-2 border-zinc-200 border-t-zinc-950 rounded-full animate-spin"></div>
            </div>

            <div v-else-if="error" class="flex flex-col items-center justify-center h-40">
              <p class="text-sm font-medium text-zinc-400">无法加载文档内容</p>
              <button @click="fetchData" class="mt-2 text-xs font-bold underline hover:text-zinc-950">重试</button>
            </div>

            <div v-else class="zinc-doc font-sans selection:bg-zinc-950 selection:text-white" v-html="renderedContent"></div>

          </div>

          <footer class="p-5 sm:p-6 border-t border-zinc-100 bg-white/50 backdrop-blur flex justify-end items-center shrink-0 rounded-b-2xl">
            <button 
              @click="close" 
              class="w-full sm:w-auto px-10 py-3.5 sm:py-3 bg-zinc-950 text-white text-xs font-bold tracking-widest uppercase hover:opacity-90 transition-opacity rounded-lg sm:rounded-sm shadow-lg shadow-zinc-950/20 active:scale-[0.98]"
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
import { ref, watch } from 'vue'
import { getPageData } from '@/api/system'
import MarkdownIt from 'markdown-it'

const props = defineProps<{ 
  visible: boolean,
  type: 'privacy' | 'guidelines'
}>()

const emit = defineEmits<{ (e: 'update:visible', value: boolean): void }>()

// 初始化放在 setup 中，避免重复实例化
const md = new MarkdownIt({ html: true, breaks: true, linkify: true })

const titleMap: Record<string, string> = {
  privacy: '隐私政策',
  guidelines: '用户守则'
}

const renderedContent = ref('')
const loading = ref(false)
const error = ref(false)
const loadedType = ref('') 

const close = () => emit('update:visible', false)

const fetchData = async () => {
  // 如果已经正在加载，避免重复请求 (性能优化)
  if (loading.value) return

  loading.value = true
  error.value = false
  try {
    const res = await getPageData(props.type)
    // 增加数据结构防御性检查 (安全性/健壮性)
    const rawContent = (res as any)?.data?.content || (res as any)?.content || ''
    
    if (rawContent) {
      renderedContent.value = md.render(rawContent)
      loadedType.value = props.type
    } else {
      renderedContent.value = md.render(`### No Content\n暂未配置${titleMap[props.type]}。`)
    }
  } catch (err) {
    console.error('Failed to load policy:', err)
    error.value = true
  } finally {
    loading.value = false
  }
}

// 监听可见性变化，实现按需加载
watch(() => props.visible, (newVal) => {
  if (newVal && loadedType.value !== props.type) {
    fetchData()
  }
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

/* --- Zinc Editorial Typography (保持原有风格) --- */
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
</style>