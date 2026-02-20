<template>
  <div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen flex flex-col">
    
    <div v-if="loading" class="animate-pulse space-y-8 py-8">
      <div class="h-8 sm:h-12 bg-zinc-100 w-2/3"></div> 
      <div class="flex gap-4">
        <div class="h-4 bg-zinc-100 w-24"></div> 
      </div>
      <div class="space-y-4 pt-8 sm:pt-12">
        <div v-for="i in 5" :key="i" class="h-4 bg-zinc-100 w-full"></div>
      </div>
    </div>

    <article v-else-if="!error" class="animate-in fade-in slide-in-from-bottom-4 duration-700 grow">
      
      <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
        <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6 tracking-tighter">
          关于
        </h1>
        
        <div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
          <time>{{ new Date().getFullYear() }}</time>
          <span class="text-zinc-300 font-light">/</span>
          <span class="text-zinc-600 font-medium tracking-[0.05em]">MANIFESTO</span>
          <span class="text-zinc-300 font-light">/</span>
          <span>README.MD</span>
        </div>
      </header>

      <div 
        class="prose prose-zinc prose-base sm:prose-lg max-w-none subpixel-antialiased
               prose-headings:text-zinc-950 prose-headings:font-bold prose-headings:tracking-tighter prose-headings:mt-12 sm:prose-headings:mt-16 prose-headings:mb-6
               prose-p:text-zinc-800 prose-p:leading-relaxed sm:prose-p:leading-loose prose-p:mb-8 prose-p:tracking-[0.01em]
               prose-a:text-zinc-950 prose-a:underline prose-a:underline-offset-4 hover:prose-a:opacity-60 transition-all
               prose-blockquote:border-l-zinc-200 prose-blockquote:font-normal prose-blockquote:text-zinc-500 prose-blockquote:not-italic prose-blockquote:pl-8
               prose-strong:text-zinc-950 prose-strong:font-bold
               prose-hr:border-zinc-100
               prose-img:rounded-none prose-img:border prose-img:border-zinc-100
               prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0"
        v-html="renderedContent"
      ></div>

      <footer class="mt-24 pt-10 border-t border-zinc-100 mb-20 flex justify-between items-center opacity-80 hover:opacity-100 transition-opacity">
        <div class="flex flex-col gap-1">
          <span class="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-950">
            {{ siteStore.siteInfo.title }}
          </span>
        </div>
      </footer>

    </article>

    <div v-else class="py-32 text-center grow flex flex-col items-center justify-center">
      <p class="text-xs font-mono font-medium tracking-widest uppercase text-zinc-400 mb-6">
        连接丢失。
      </p>
      <button 
        @click="fetchData" 
        class="text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 border-b border-zinc-950 pb-0.5 hover:text-zinc-500 hover:border-zinc-500 transition-all"
      >
        重连
      </button>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import MarkdownIt from 'markdown-it'
import { createHighlighter } from 'shiki' 
import { getPageData } from '@/api/system'
import { useSiteStore } from '@/store/site'

const siteStore = useSiteStore()

const renderedContent = ref('')
const loading = ref(true)
const error = ref(false)

// 🌟 性能最大化：高亮器单例模式，避免重复下载与初始化
let highlighterInstance: any = null

/**
 * 🌟 Markdown 定制化渲染逻辑
 */
const renderMarkdown = async (content: string) => {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
  
  if (!highlighterInstance) {
    highlighterInstance = await createHighlighter({
      themes: ['vitesse-light'], 
      langs: ['csharp', 'typescript', 'javascript', 'sql', 'bash', 'json', 'html', 'css', 'yaml', 'markdown']
    })
  }

  md.options.highlight = (code, lang) => {
    return highlighterInstance.codeToHtml(code, { lang: lang || 'text', theme: 'vitesse-light' })
  }
  renderedContent.value = md.render(content)
}

/**
 * 数据抓取逻辑
 */
const fetchData = async () => {
  loading.value = true
  error.value = false
  try {
    const res = await getPageData('about')
    // 逻辑自洽：兼容多层级数据结构
    const rawContent = (res as any).data?.content || (res as any).content || ''
    
    if (rawContent) {
      await renderMarkdown(rawContent)
    } else {
      await renderMarkdown('> 暂无介绍内容。')
    }
  } catch (err) {
    error.value = true
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchData()
})
</script>

<style>
@reference "@/assets/main.css";

/* 🌟 Shiki 代码块：无边界融入设计，解决移动端溢出问题 */
.shiki {
  padding: 1.5rem !important;
  margin: 1.5rem -1.5rem !important; 
  background-color: #fbfbfb !important;
  border-radius: 0;
  font-size: 0.85rem;
  font-family: 'JetBrains Mono', monospace;
  line-height: 1.7;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border-top: 1px solid rgba(24, 24, 27, 0.05);
  border-bottom: 1px solid rgba(24, 24, 27, 0.05);
}

@media (min-width: 640px) {
  .shiki { 
    font-size: 0.9rem; 
    padding: 2rem !important; 
    margin: 2.5rem 0 !important; 
    border: 1px solid rgba(24, 24, 27, 0.05);
    border-radius: 2px;
  }
}

/* 🌟 引用块重塑：解决线字混叠，提升阅读质感 */
.prose blockquote {
  border-left-width: 2px !important;
  border-left-color: #e4e4e7 !important; /* zinc-200 */
  background-color: transparent !important;
  font-style: normal !important;
  margin: 2.5rem 0 !important;
  padding-left: 2rem !important; /* 彻底拉开距离 */
  line-height: 1.8 !important;
  letter-spacing: 0.025em !important;
}

.prose blockquote p:before,
.prose blockquote p:after { 
  content: none !important; 
}

/* 🌟 内联代码：黑白灰阶降噪 */
.prose :not(pre) > code {
  background-color: #f4f4f5 !important;
  color: #18181b !important;
  padding: 0.2rem 0.4rem !important;
  border-radius: 2px !important;
  font-weight: 500 !important;
}

/* 🌟 图片：全宽适配与极简边框 */
.prose img { 
  width: 100%; 
  height: auto; 
  margin: 2rem -1.5rem;
  width: calc(100% + 3rem);
  max-width: none;
  border-top: 1px solid #f4f4f5;
  border-bottom: 1px solid #f4f4f5;
  border-radius: 0;
}

@media (min-width: 640px) {
  .prose img {
    margin: 3.5rem auto;
    width: 100%;
    max-width: 100%;
    border-radius: 2px;
    border: 1px solid #f4f4f5;
  }
}

/* 🌟 列表对齐微调 */
.prose ul, .prose ol {
  padding-left: 1.25rem;
}

.prose li::marker {
  color: #d4d4d8; /* zinc-300 */
}
</style>