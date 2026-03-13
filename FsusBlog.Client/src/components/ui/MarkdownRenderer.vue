<template>
  <div 
    ref="rootEl"
    class="markdown-body prose prose-zinc max-w-none subpixel-antialiased" 
    v-html="renderedContent"
  ></div>
</template>

<script setup lang="ts">
import { shallowRef, watch, onUnmounted, ref } from 'vue'
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

// 🚀 性能优化: 浅层响应式，避免超长 HTML 字符串的深层 Proxy 劫持
const renderedContent = shallowRef('')

// ==========================================
// 1. 全局单例与静态配置 (共享内存)
// ==========================================

const SAFE_URI_REGEXP = /^(?:https?|mailto|tel):/i;
const ALLOWED_LANGS =['csharp', 'typescript', 'javascript', 'sql', 'bash', 'json', 'html', 'css', 'yaml', 'markdown', 'text', 'xml', 'java', 'python', 'cpp'];

// 🚀 性能优化: LRU 高亮缓存 (极大提升实时预览/热更新性能)
const highlightCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

const md = new MarkdownIt({ 
  html: false, 
  linkify: true, 
  typographer: true 
});

md.validateLink = (url: string) => SAFE_URI_REGEXP.test(url);

const originalLinkOpen = md.renderer.rules.link_open || function(tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options);
};

// 安全跳转防线
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (!token) return originalLinkOpen(tokens, idx, options, env, self);

  const hrefIndex = token.attrIndex('href');
  if (hrefIndex >= 0 && token.attrs) {
    const attrPair = token.attrs[hrefIndex];
    if (attrPair && !SAFE_URI_REGEXP.test(attrPair[1])) {
      attrPair[1] = '#'; 
    }
    token.attrPush(['rel', 'noopener noreferrer']);
    token.attrPush(['target', '_blank']);
  }
  return originalLinkOpen(tokens, idx, options, env, self);
};

// 原生图片懒加载
const originalImage = md.renderer.rules.image || function(tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    token.attrPush(['loading', 'lazy']);
    token.attrPush(['decoding', 'async']);
    token.attrPush(['referrerpolicy', 'no-referrer']);
  }
  return originalImage(tokens, idx, options, env, self);
};

// ==========================================
// 2. 高亮引擎与渲染控制
// ==========================================

let highlighterInstance: any = null;
let highlighterPromise: Promise<any> | null = null;

md.options.highlight = (code, lang) => {
  if (code.length > 50000) return ''; // 物理拦截防 OOM
  
  const safeLang = lang && ALLOWED_LANGS.includes(lang) ? lang : 'text';
  const cacheKey = `${safeLang}:${code}`;

  // O(1) 缓存命中
  if (highlightCache.has(cacheKey)) {
    return highlightCache.get(cacheKey)!;
  }
  
  let resultHtml = '';
  if (!highlighterInstance) {
    resultHtml = `<pre class="shiki"><code>${md.utils.escapeHtml(code)}</code></pre>`;
  } else {
    try {
      resultHtml = highlighterInstance.codeToHtml(code, { lang: safeLang, theme: 'vitesse-light' });
    } catch (e) {
      resultHtml = `<pre class="shiki"><code>${md.utils.escapeHtml(code)}</code></pre>`;
    }
  }

  highlightCache.set(cacheKey, resultHtml);
  if (highlightCache.size > MAX_CACHE_SIZE) {
    highlightCache.delete(highlightCache.keys().next().value!);
  }
  
  return resultHtml;
};

// ==========================================
// 3. 异步渲染调度器
// ==========================================

let lastRenderTaskId = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const performRender = async (rawContent: string) => {
  const taskId = ++lastRenderTaskId;

  if (!highlighterInstance) {
    if (!highlighterPromise) {
      highlighterPromise = createHighlighter({
        themes:['vitesse-light'], 
        langs: ALLOWED_LANGS
      }).catch(err => {
        console.error('[Shiki] Load failed:', err);
        highlighterPromise = null;
        return null;
      });
    }
    highlighterInstance = await highlighterPromise;
    if (taskId === lastRenderTaskId && highlighterInstance) {
      return performRender(rawContent); 
    }
  }

  if (taskId !== lastRenderTaskId) return;

  try {
    const rawHtml = md.render(rawContent || '');

    // 严格净化，保留 Shiki 的 style
    const cleanHtml = DOMPurify.sanitize(rawHtml, { 
      USE_PROFILES: { html: true },
      FORBID_TAGS:['script', 'svg', 'math', 'form', 'object', 'embed', 'iframe'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
      ADD_ATTR:['loading', 'decoding', 'referrerpolicy', 'target', 'rel'],
      ALLOWED_URI_REGEXP: SAFE_URI_REGEXP
    });

    if (taskId === lastRenderTaskId) {
      renderedContent.value = cleanHtml;
      emit('render-complete');
    }
  } catch (err) {
    console.error('[MarkdownRenderer] Critical failure:', err);
    if (taskId === lastRenderTaskId) {
      renderedContent.value = `<p>渲染发生异常。</p>`;
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

/* =======================================================
   一、高级文本编排引擎 (Advanced Typography & CJK Rules)
======================================================= */

.markdown-body {
  color: #27272a; /* zinc-800 */
  font-size: 1.05rem; 
  line-height: 1.8; 
  letter-spacing: 0.015em;
  text-align: justify; 
  font-weight: 400;

  /* 中西文混排自动间距与标点挤压 (Modern Web Standard) */
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
  /* 将 Markdown 的双换行符 gap 收缩为 0.6em，消除网页巨大的空行断层感 */
  margin-bottom: 0.6em; 
  text-indent: 2em; /* 纸质书特征：首行缩进 */
}

/* 拦截并折叠恶意/无效空行 */
.markdown-body p:empty { display: none !important; }
.markdown-body br + br { display: none; }

/* 包含图片的段落禁止缩进，保持绝对居中 */
.markdown-body p:has(img) {
  text-indent: 0;
  text-align: center;
  margin-top: 2em;
  margin-bottom: 2em;
}

/* =======================================================
   三、出版级标题结构 (Editorial Subheadings)
======================================================= */

.markdown-body h1, 
.markdown-body h2, 
.markdown-body h3, 
.markdown-body h4, 
.markdown-body h5, 
.markdown-body h6 {
  color: #18181b; /* zinc-900 */
  line-height: 1.5;
  text-indent: 0 !important; /* 标题绝对禁止缩进 */
}

/* 消除顶部元素的无意义边距 */
.markdown-body > *:first-child { margin-top: 0 !important; }

/* H1: 篇名/大标题 (保留作为绝对视觉重心的体量) */
.markdown-body h1 { 
  font-size: 1.6em; 
  font-weight: 600;
  margin-top: 2.5em; 
  margin-bottom: 1.5em; 
  text-align: center;
}

/* H2: 纸质书核心章节分割 (Chapter Break) */
.markdown-body h2 { 
  font-size: 1.15em;    
  font-weight: 500;     
  color: #27272a;       
  text-align: center;   
  margin-top: 4em;      
  margin-bottom: 2em;   
  border-bottom: none;  
  padding-bottom: 0;
}

/* H3: 文内小节/场景切换 (Scene Shift) */
.markdown-body h3 { 
  font-size: 1.05em;    
  font-weight: 600;     
  text-align: left;
  margin-top: 3em; 
  margin-bottom: 1em; 
}

/* H4 及以下：普通附属级标题 */
.markdown-body h4, 
.markdown-body h5, 
.markdown-body h6 {
  font-size: 1.05em; 
  font-weight: 500;   
  color: #3f3f46;       
  text-align: left;
  margin-top: 2.5em;  
  margin-bottom: 1em;
}

/* 物理防线：避免连续标题产生过大空白 */
.markdown-body h2 + h3,
.markdown-body h3 + h4 {
  margin-top: 1.5em;
}

/* =======================================================
   四、引用语块 (Paper-book Blockquotes)
======================================================= */

.markdown-body blockquote {
  border-left: none !important;        
  margin: 2.5rem 3rem !important;      
  padding: 0 !important;
  color: #52525b !important;           
  font-size: 0.95em;                   
  font-weight: 300 !important;         
  font-style: normal !important;       
  background: transparent !important;
}

.markdown-body blockquote p {
  text-indent: 2em;                    
  margin-bottom: 0.5em;                
}
.markdown-body blockquote p:last-child {
  margin-bottom: 0; 
}

@media (max-width: 640px) {
  .markdown-body blockquote { margin: 2rem 1.2rem !important; }
}

/* =======================================================
   五、列表与极简交互 (Lists & Links)
======================================================= */

.markdown-body ul, 
.markdown-body ol {
  /* 【物理修复】双侧大留白，将其推向中轴线，与居中的标题保持视觉连贯 */
  margin: 1.5rem 3rem; 
  padding-left: 1.5em;
}

/* 移动端削弱双侧缩进，防止文字挤成一团 */
@media (max-width: 640px) {
  .markdown-body ul, 
  .markdown-body ol {
    margin: 1.5rem 1.5rem; 
  }
}

.markdown-body li {
  line-height: 1.8;
  margin-bottom: 0.6em;
}

.markdown-body li p {
  text-indent: 0 !important; 
  margin-bottom: 0 !important;
  margin-top: 0.2em;
}

.markdown-body li::marker {
  color: #a1a1aa; 
}

.markdown-body a {
  text-indent: 0;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-color: #d4d4d8;
  transition: all 0.2s ease;
}
.markdown-body a:hover {
  text-decoration-color: var(--color-primary, #3b82f6);
  color: var(--color-primary, #3b82f6);
}

/* =======================================================
   六、多媒体与代码 (Media & Code)
======================================================= */

.markdown-body img {
  display: block;
  margin: 2rem auto;
  max-width: 100%;
  max-height: 75vh;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 4px 20px -4px rgba(0, 0, 0, 0.05);
}

.markdown-body hr {
  border: none;
  border-top: 1px solid #f4f4f5; 
  margin: 3.5rem 20%; 
}

.markdown-body .shiki {
  padding: 1.5rem !important;
  margin: 2rem 0 !important;
  background-color: #fafafa !important;
  border: 1px solid #f4f4f5 !important;
  border-radius: 8px;
  font-size: 0.85rem;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.6;
  overflow-x: auto;
  text-indent: 0 !important;
}

.markdown-body p + pre.shiki { margin-top: 1.5em !important; }
.markdown-body pre.shiki + p { margin-top: 1.5em !important; }

.markdown-body :not(pre) > code {
  background-color: #f4f4f5 !important;
  color: #18181b !important;
  padding: 0.2em 0.4em !important;
  border-radius: 4px !important;
  font-size: 0.85em;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-weight: 500 !important;
  white-space: nowrap;
}

/* =======================================================
   七、技术类表格排版引擎 (Modern Minimalist Tables)
======================================================= */

.markdown-body table {
  /* 【物理修复】改为 max-content 并 margin: auto。内容较少时绝对居中，内容多时撑满滚动 */
  width: max-content; 
  max-width: 100%;
  margin: 3.5rem auto; 
  border-collapse: collapse;
  border-spacing: 0;
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch; 
  font-size: 0.9em; 
  line-height: 1.6;
  text-indent: 0 !important; 
}

.markdown-body table::-webkit-scrollbar { height: 6px; }
.markdown-body table::-webkit-scrollbar-thumb { background-color: #e4e4e7; border-radius: 3px; }
.markdown-body table::-webkit-scrollbar-track { background-color: transparent; }

.markdown-body thead {
  background-color: transparent; 
  border-bottom: 1px solid #d4d4d8; 
}

.markdown-body th {
  font-weight: 500;
  color: #3f3f46; 
  padding: 1rem 1.25rem;
  text-align: left; 
  white-space: nowrap; 
}

.markdown-body tbody tr {
  border-bottom: 1px solid #f4f4f5; 
  transition: background-color 0.2s ease;
}
.markdown-body tbody tr:hover { background-color: #fafafa; }

.markdown-body td {
  padding: 1rem 1.25rem;
  color: #52525b; 
  vertical-align: top; 
  min-width: 120px; 
}

.markdown-body td p,
.markdown-body th p {
  text-indent: 0 !important; 
  margin: 0 !important;
  text-align: inherit; 
}

.markdown-body td code,
.markdown-body th code {
  white-space: normal; 
  word-break: break-all; 
  background-color: transparent !important; 
  border: 1px solid #e4e4e7;
  color: #09090b !important;
}

.markdown-body td ul,
.markdown-body td ol {
  margin: 0;
  padding-left: 1.5em;
}
</style>