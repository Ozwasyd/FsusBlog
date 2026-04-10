<template>
  <div
    id="fsus-aot-shell"
    data-public-hydration-kind="About"
    class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"
  >
    <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
        <div class="shrink-0">
          <a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">
            {{ siteTitleText }}<span class="text-zinc-400">.</span>
          </a>
        </div>
        <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
          <a href="/" class="mono-link">首页</a>
          <a href="/archive" class="mono-link">归档</a>
          <a href="/about" class="mono-link active-link">关于</a>
          <form action="/search" method="get" class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
            <input
              type="text"
              name="q"
              placeholder="搜索"
              class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5"
              aria-label="搜索内容"
            />
          </form>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <a href="/login" class="mono-link">登录</a>
        </nav>
      </div>
    </header>

    <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
      <article class="animate-in fade-in slide-in-from-bottom-4 duration-700 min-h-[60vh]">
        <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
          <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6 tracking-tighter">{{ titleText }}</h1>
          <div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
            <time>{{ currentYear }}</time>
            <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
            <span class="text-zinc-600 font-medium tracking-[0.05em]">MANIFESTO</span>
            <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
            <span>README.MD</span>
          </div>
        </header>
        <div class="markdown-body markdown-renderer__body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap" role="article" aria-live="polite" data-markdown-renderer="wasm">
          {{ aboutContent }}
        </div>
      </article>
    </main>

    <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
        <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">
          &copy; {{ currentYear }} {{ siteTitleText }}. All rights reserved.
        </div>
        <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500">
          <a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a>
          <a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group">
            <span>回到顶部</span>
            <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
          </a>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PublicPassiveHydrationPayload } from './types'

const props = defineProps<PublicPassiveHydrationPayload>()
const currentYear = new Date().getFullYear()
const siteTitleText = computed(() => props.siteTitle?.trim() || 'Fsus')
const titleText = computed(() => props.title?.trim() || '关于')
const aboutContent = computed(() => props.about?.content?.trim() || '')
</script>
