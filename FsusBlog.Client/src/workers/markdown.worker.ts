// src/workers/markdown.worker.ts
import MarkdownIt from 'markdown-it'
import { createHighlighter } from 'shiki'
import markdownItKatex from '@iktakahiro/markdown-it-katex'

const SAFE_URI_REGEXP = /^(?:https?|mailto|tel):/i;
const ALLOWED_LANGS =['csharp', 'typescript', 'javascript', 'sql', 'bash', 'json', 'html', 'css', 'yaml', 'markdown', 'text', 'xml', 'java', 'python', 'cpp'];

// 性能优化: Worker 内存级 LRU 缓存
const highlightCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

const md = new MarkdownIt({ 
  html: false, 
  linkify: true, 
  typographer: true 
}).use(markdownItKatex);

md.validateLink = (url: string) => SAFE_URI_REGEXP.test(url);

const originalLinkOpen = md.renderer.rules.link_open || function(tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (!token) return originalLinkOpen(tokens, idx, options, env, self);

  const hrefIndex = token.attrIndex('href');
  if (hrefIndex >= 0 && token.attrs) {
    const attrPair = token.attrs[hrefIndex];
    if (attrPair && !SAFE_URI_REGEXP.test(attrPair[1])) {
      attrPair[1] = '#'; 
    }
    token.attrSet('rel', 'noopener noreferrer');
    token.attrSet('target', '_blank');
  }
  return originalLinkOpen(tokens, idx, options, env, self);
};

const originalImage = md.renderer.rules.image || function(tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    token.attrSet('referrerpolicy', 'no-referrer');
  }
  return originalImage(tokens, idx, options, env, self);
};

let highlighterInstance: any = null;
let highlighterPromise: Promise<any> | null = null;

// Worker 启动时立刻在后台静默预热 Shiki 引擎
highlighterPromise = createHighlighter({
  themes: ['vitesse-light'], 
  langs: ALLOWED_LANGS
}).then(instance => {
  highlighterInstance = instance;
}).catch(err => {
  console.error('[Worker] Shiki 引擎装载崩溃:', err);
});

md.options.highlight = (code, lang) => {
  if (code.length > 50000) return ''; 
  
  const safeLang = lang && ALLOWED_LANGS.includes(lang) ? lang : 'text';
  const cacheKey = `${safeLang}:${code}`;

  if (highlightCache.has(cacheKey)) {
    const cachedHtml = highlightCache.get(cacheKey)!;
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cachedHtml);
    return cachedHtml;
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

// 核心通信总线：接收主线程发来的 Markdown 文本，返回安全 HTML
self.onmessage = async (e: MessageEvent) => {
  const { id, content } = e.data;

  // 确保异步引擎加载完成
  if (!highlighterInstance && highlighterPromise) {
    await highlighterPromise;
  }

  try {
    const rawHtml = md.render(content || '');

    self.postMessage({ id, html: rawHtml });
  } catch (err: any) {
    self.postMessage({ id, html: `<p>渲染调度失败: ${err.message}</p>` });
  }
};