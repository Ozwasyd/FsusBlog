<template>
  <div 
    ref="rootEl"
    class="prose prose-zinc prose-base sm:prose-lg max-w-none subpixel-antialiased
           prose-headings:text-zinc-950 prose-headings:font-bold prose-headings:tracking-tighter
           prose-p:text-zinc-800 prose-p:leading-relaxed prose-p:tracking-[0.01em]
           prose-li:text-zinc-800 prose-li:leading-relaxed
           prose-a:text-zinc-950 prose-a:underline prose-a:underline-offset-4 hover:prose-a:opacity-60 transition-all
           prose-blockquote:border-l-zinc-200 prose-blockquote:font-normal prose-blockquote:text-zinc-500 prose-blockquote:not-italic prose-blockquote:pl-8
           prose-strong:text-zinc-950 prose-strong:font-bold
           prose-hr:border-zinc-100
           prose-img:rounded-md prose-img:mx-auto prose-img:shadow-sm prose-img:border prose-img:border-zinc-100" 
    v-html="renderedContent"
  ></div>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import MarkdownIt from 'markdown-it'
import { createHighlighter } from 'shiki'
import DOMPurify from 'dompurify'

const props = defineProps<{
  content: string
}>()

const emit = defineEmits<{
  (e: 'render-complete'): void
}>()

const rootEl = ref<HTMLElement | null>(null)
const renderedContent = ref('')

// ==========================================
// 1. 静态配置与单例管理
// ==========================================

const SAFE_URI_REGEXP = /^(?:https?|mailto|tel):/i;
const ALLOWED_LANGS = ['csharp', 'typescript', 'javascript', 'sql', 'bash', 'json', 'html', 'css', 'yaml', 'markdown', 'text'];

const md = new MarkdownIt({ 
  html: false, 
  linkify: true, 
  typographer: true 
});

md.validateLink = (url: string) => SAFE_URI_REGEXP.test(url);

const originalRender = md.renderer.rules.link_open || function(tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
};

// [修复 2026-02-24] 修复 TS 18048: 显式类型收窄
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  
  // 物理检查：如果 token 缺失，直接降级执行原始渲染
  if (!token) return originalRender(tokens, idx, options, env, self);

  const hrefIndex = token.attrIndex('href');
  if (hrefIndex >= 0 && token.attrs) {
    const attrPair = token.attrs[hrefIndex];
    if (attrPair && !SAFE_URI_REGEXP.test(attrPair[1])) {
      attrPair[1] = '#'; 
    }
    token.attrPush(['rel', 'noopener noreferrer']);
    token.attrPush(['target', '_blank']);
  }
  return originalRender(tokens, idx, options, env, self);
};

md.renderer.rules.image = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  
  // [修复 2026-02-24] 修复 TS 18048: 防御性检查
  if (token) {
    token.attrPush(['loading', 'lazy']);
    token.attrPush(['decoding', 'async']);
    token.attrPush(['referrerpolicy', 'no-referrer']);
  }
  return self.renderToken(tokens, idx, options);
};

// ==========================================
// 2. 高亮引擎与渲染控制
// ==========================================

let highlighterInstance: any = null;
let highlighterPromise: Promise<any> | null = null;
let lastRenderTaskId = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const performRender = async (rawContent: string) => {
  const taskId = ++lastRenderTaskId;

  if (!highlighterInstance) {
    if (!highlighterPromise) {
      highlighterPromise = createHighlighter({
        themes: ['vitesse-light'], 
        langs: ALLOWED_LANGS
      }).catch(err => {
        console.error('[Shiki] Load failed:', err);
        highlighterPromise = null;
        return null;
      });
    }
    highlighterInstance = await highlighterPromise;
  }

  if (taskId !== lastRenderTaskId) return;

  md.options.highlight = (code, lang) => {
    if (code.length > 30000) return '';
    
    if (!highlighterInstance || !ALLOWED_LANGS.includes(lang || '')) {
      return `<pre class="shiki"><code>${md.utils.escapeHtml(code)}</code></pre>`;
    }
    try {
      return highlighterInstance.codeToHtml(code, { lang: lang || 'text', theme: 'vitesse-light' });
    } catch (e) {
      return `<pre class="shiki"><code>${md.utils.escapeHtml(code)}</code></pre>`;
    }
  };

  try {
    const rawHtml = md.render(rawContent || '');

    const cleanHtml = DOMPurify.sanitize(rawHtml, { 
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'svg', 'math', 'form', 'object', 'embed'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
      ADD_ATTR: ['loading', 'decoding', 'referrerpolicy', 'target', 'rel'],
      ALLOWED_URI_REGEXP: SAFE_URI_REGEXP
    });

    if (taskId === lastRenderTaskId) {
      renderedContent.value = cleanHtml;
      emit('render-complete');
    }
  } catch (err) {
    console.error('[MarkdownRenderer] Critical failure:', err);
    if (taskId === lastRenderTaskId) {
      renderedContent.value = `<pre><code>${md.utils.escapeHtml(rawContent)}</code></pre>`;
    }
  }
}

watch(() => props.content, (newVal) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    performRender(newVal);
  }, 50);
}, { immediate: true });

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  lastRenderTaskId++; 
});

defineExpose({
  rootEl
})
</script>

<style>
@reference "@/assets/main.css";

.shiki {
  padding: 1.5rem !important;
  margin: 2rem 0 !important;
  background-color: #fbfbfb !important;
  border: 1px solid rgba(24, 24, 27, 0.05) !important;
  border-radius: 2px;
  font-size: 0.85rem;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  line-height: 1.7;
  overflow-x: auto;
  contain: content;
}

.prose :not(pre)>code {
  background-color: #f4f4f5 !important;
  color: #18181b !important;
  padding: 0.2rem 0.4rem !important;
  border-radius: 2px !important;
  font-weight: 500 !important;
}

.prose blockquote {
  border-left: 2px solid #e4e4e7 !important;
  background-color: transparent !important;
  font-style: normal !important;
  margin: 2.5rem 0 !important;
  padding-left: 2rem !important;
  line-height: 1.8 !important;
}

.prose img {
  display: block;
  margin: 2rem auto;
  max-width: 100%;
  max-height: 75vh;
  object-fit: contain;
  background-color: #fff;
}
</style>