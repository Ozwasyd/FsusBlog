<template>
  <div 
    ref="rootEl"
    class="markdown-body prose prose-zinc max-w-none subpixel-antialiased" 
    v-html="renderedContent"
  ></div>
</template>

<script setup lang="ts">
import { shallowRef, watch, onUnmounted, ref } from 'vue'
import DOMPurify from 'dompurify'
// CSS 必须在主线程组件中引入
import 'katex/dist/katex.min.css'

const props = defineProps<{ content: string }>()
const emit = defineEmits<{ (e: 'render-complete'): void }>()

const rootEl = ref<HTMLElement | null>(null)
const renderedContent = shallowRef('')
const SAFE_URI_REGEXP = /^(?:https?|mailto|tel):/i;

let worker: Worker | null = null;
let currentTaskId = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 🚀 实例化 Web Worker (Vite 原生支持该语法)
const initWorker = () => {
  if (typeof window === 'undefined') return;
  worker = new Worker(new URL('@/workers/markdown.worker.ts', import.meta.url), { type: 'module' });
  
  worker.onmessage = (e: MessageEvent) => {
    const { id, html } = e.data;
    // 物理级防抖竞态控制：如果用户输入极快，只将最新一次（id匹配）的结果刷入 DOM
    if (id === currentTaskId) {
          // DOMPurify 也在 Worker 中执行，彻底解放主线程
      const cleanHtml = DOMPurify.sanitize(html, { 
        USE_PROFILES: { html: true, mathMl: true }, 
        FORBID_TAGS:['script', 'svg', 'form', 'object', 'embed', 'iframe'], 
        FORBID_ATTR:['onerror', 'onload', 'onclick', 'onmouseover'],
        ADD_ATTR:['loading', 'decoding', 'referrerpolicy', 'target', 'rel'],
        ALLOWED_URI_REGEXP: SAFE_URI_REGEXP
      });
      renderedContent.value = cleanHtml;
      emit('render-complete');
    }
  };
};

initWorker();

const performRender = (rawContent: string) => {
  if (!worker) return;
  const taskId = ++currentTaskId;
  worker.postMessage({ id: taskId, content: rawContent });
}

watch(() => props.content, (newVal) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  // 极限物理加速：由于已经剥离了主线程，防抖延迟从 50ms 激进地压缩至 16ms（约1帧）
  // 实现了肉眼不可见的几乎绝对零延迟预览同步！
  debounceTimer = setTimeout(() => {
    performRender(newVal);
  }, 16); 
}, { immediate: true });

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (worker) {
    worker.terminate(); // 物理斩断后台线程释放内存
    worker = null;
  }
});

defineExpose({ rootEl })
</script>

<style>
@reference "@/assets/main.css";

/* =======================================================
   一、高级文本编排引擎 (Advanced Typography & CJK Rules)
======================================================= */

.markdown-body {
  color: #27272a; 
  font-size: 1.05rem; 
  line-height: 1.8; 
  letter-spacing: 0.015em;
  text-align: justify; 
  font-weight: 400;

  text-autospace: ideograph-alpha ideograph-numeric;
  text-spacing-trim: space-all; 
  
  word-break: break-word;
  overflow-wrap: break-word;
}

/* =======================================================
   二、段落节律 (Paper-book Paragraph Rhythm)
======================================================= */

.markdown-body p {
  margin-top: 0;
  margin-bottom: 0.6em; 
  text-indent: 2em; 
}

.markdown-body p:empty { display: none !important; }
.markdown-body br + br { display: none; }

.markdown-body p:has(img),
.markdown-body p:has(.katex-display) {
  text-indent: 0;
  text-align: center;
  margin-top: 2em;
  margin-bottom: 2em;
}

/* =======================================================
   三、出版级标题结构 (Editorial Subheadings)
======================================================= */

.markdown-body h1, .markdown-body h2, .markdown-body h3, 
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  color: #18181b; 
  line-height: 1.5;
  text-indent: 0 !important; 
}

.markdown-body > *:first-child { margin-top: 0 !important; }

.markdown-body h1 { 
  font-size: 1.6em; font-weight: 600; margin-top: 2.5em; margin-bottom: 1.5em; text-align: center;
}

.markdown-body h2 { 
  font-size: 1.15em; font-weight: 500; color: #27272a; text-align: center; margin-top: 4em; margin-bottom: 2em; border-bottom: none; padding-bottom: 0;
}

.markdown-body h3 { 
  font-size: 1.05em; font-weight: 600; text-align: left; margin-top: 3em; margin-bottom: 1em; 
}

.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  font-size: 1.05em; font-weight: 500; color: #3f3f46; text-align: left; margin-top: 2.5em; margin-bottom: 1em;
}

.markdown-body h2 + h3, .markdown-body h3 + h4 { margin-top: 1.5em; }

/* =======================================================
   四、引用语块 (Paper-book Blockquotes)
======================================================= */

.markdown-body blockquote {
  border-left: none !important; margin: 2.5rem 3rem !important; padding: 0 !important;
  color: #52525b !important; font-size: 0.95em; font-weight: 300 !important; font-style: normal !important; background: transparent !important;
}
.markdown-body blockquote p { text-indent: 2em; margin-bottom: 0.5em; }
.markdown-body blockquote p:last-child { margin-bottom: 0; }
@media (max-width: 640px) { .markdown-body blockquote { margin: 2rem 1.2rem !important; } }

/* =======================================================
   五、列表与极简交互 (Lists & Links)
======================================================= */

.markdown-body ul { list-style-type: disc; margin: 1.5rem 3rem; padding-left: 1.5em; }
.markdown-body ol { list-style-type: decimal; margin: 1.5rem 3rem; padding-left: 1.5em; }
.markdown-body ul ul { list-style-type: circle; margin: 0.5rem 0; }
.markdown-body ul ul ul { list-style-type: square; }

@media (max-width: 640px) { .markdown-body ul, .markdown-body ol { margin: 1.5rem 1.5rem; } }

.markdown-body li { line-height: 1.8; margin-bottom: 0.6em; display: list-item; }
.markdown-body li p { text-indent: 0 !important; margin-bottom: 0 !important; margin-top: 0.2em; }
.markdown-body li::marker { color: #a1a1aa; }

.markdown-body a { text-indent: 0; color: inherit; text-decoration: underline; text-underline-offset: 4px; text-decoration-color: #d4d4d8; transition: all 0.2s ease; }
.markdown-body a:hover { text-decoration-color: var(--color-primary, #3b82f6); color: var(--color-primary, #3b82f6); }

/* =======================================================
   六、多媒体与代码 (Media & Code) 
======================================================= */

.markdown-body img { display: block; margin: 2rem auto; max-width: 100%; max-height: 75vh; object-fit: contain; border-radius: 4px; box-shadow: 0 4px 20px -4px rgba(0, 0, 0, 0.05); }
.markdown-body hr { border: none; border-top: 1px solid #f4f4f5; margin: 3.5rem 20%; }

/* 🚀 GPU 级显卡优化：赋予代码块和长表格 content-visibility: auto，屏幕外的内容直接免除重绘 */
.markdown-body .shiki {
  content-visibility: auto;
  contain-intrinsic-size: 200px;
  padding: 1.5rem !important; margin: 2rem 0 !important; background-color: #fafafa !important; border: 1px solid #f4f4f5 !important; border-radius: 8px; font-size: 0.85rem; font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.6; overflow-x: auto; text-indent: 0 !important;
}
.markdown-body p + pre.shiki { margin-top: 1.5em !important; }
.markdown-body pre.shiki + p { margin-top: 1.5em !important; }

.markdown-body :not(pre) > code { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, var(--font-sans), monospace !important; font-weight: 500 !important; font-size: 0.85em; background-color: #fafafa !important; border: 1px solid #f4f4f5; color: #18181b !important; padding: 0.15em 0.4em !important; margin: 0 0.15em !important; border-radius: 4px !important; white-space: nowrap; text-indent: 0 !important; }

/* =======================================================
   七、技术类表格排版引擎 (Modern Minimalist Tables)
======================================================= */

.markdown-body table {
  content-visibility: auto; contain-intrinsic-size: 150px;
  width: max-content; max-width: 100%; margin: 3.5rem auto; border-collapse: collapse; border-spacing: 0; display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; font-size: 0.9em; line-height: 1.6; text-indent: 0 !important; 
}
.markdown-body table::-webkit-scrollbar { height: 6px; }
.markdown-body table::-webkit-scrollbar-thumb { background-color: #e4e4e7; border-radius: 3px; }
.markdown-body table::-webkit-scrollbar-track { background-color: transparent; }

.markdown-body thead { background-color: transparent; border-bottom: 1px solid #d4d4d8; }
.markdown-body th { font-weight: 500; color: #3f3f46; padding: 1rem 1.25rem; text-align: left; white-space: nowrap; }
.markdown-body tbody tr { border-bottom: 1px solid #f4f4f5; transition: background-color 0.2s ease; }
.markdown-body tbody tr:hover { background-color: #fafafa; }
.markdown-body td { padding: 1rem 1.25rem; color: #52525b; vertical-align: top; min-width: 120px; }

.markdown-body td p, .markdown-body th p { text-indent: 0 !important; margin: 0 !important; text-align: inherit; }
.markdown-body td code, .markdown-body th code { white-space: normal; word-break: break-all; background-color: transparent !important; border: 1px solid #e4e4e7; color: #09090b !important; }
.markdown-body td ul, .markdown-body td ol { margin: 0; padding-left: 1.5em; }

/* =======================================================
   八、LaTeX 数学公式排版引擎 (Mathematical Typesetting)
======================================================= */

.markdown-body .katex { font-size: 1.05em; text-indent: 0 !important; color: #18181b; }
.markdown-body .katex-display { margin: 0 !important; padding-bottom: 0.5em; overflow-x: auto; overflow-y: hidden; text-align: center; -webkit-overflow-scrolling: touch; }
.markdown-body .katex-display::-webkit-scrollbar { height: 4px; }
.markdown-body .katex-display::-webkit-scrollbar-thumb { background-color: #e4e4e7; border-radius: 2px; }
.markdown-body .katex-display::-webkit-scrollbar-track { background-color: transparent; }
</style>