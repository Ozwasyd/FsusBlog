<template>
  <div
    id="fsus-aot-shell"
    data-public-hydration-kind="About"
    class="font-sans min-h-screen flex flex-col bg-[var(--fsus-panel-bg)] text-[#0F0F11] subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-[#0F0F11] selection:text-white dark:bg-[#0F0F11] dark:text-[#FCFCFC] dark:selection:bg-[#F4F4F5] dark:selection:text-[#0F0F11]"
  >
    <header class="w-full max-w-3xl mx-auto px-6 sm:px-8 pt-12 pb-8 sm:pt-20 sm:pb-10 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
      <a href="/" class="shrink-0 rounded-[8px] text-2xl sm:text-3xl font-bold hover:opacity-60 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
        {{ siteTitleText }}<span class="text-[#A1A1AA]">.</span>
      </a>
      <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
        <a href="/" class="mono-link">首页</a>
        <a href="/archive" class="mono-link">归档</a>
        <a href="/about" class="mono-link active-link">关于</a>
        <form action="/search" method="get" class="hidden sm:flex items-center group border-b border-[#F4F4F5] dark:border-[#27272A] focus-within:border-[#2A599C] transition-colors duration-300">
          <input
            type="text"
            name="q"
            placeholder="搜索"
            class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-[#D4D4D8] text-[#8E8E93] dark:placeholder:text-[#71717A] dark:text-[#A1A1AA] focus:text-[#0F0F11] dark:focus:text-[#F4F4F5] pb-0.5"
            aria-label="搜索内容"
          />
        </form>
        <ThemeModeToggle class="hidden sm:inline-flex" />
        <span class="text-[#D4D4D8] font-light dark:text-[#3F3F46]" aria-hidden="true">/</span>
        <a href="/login" class="mono-link">登录</a>
      </nav>
    </header>

    <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
      <article class="min-h-[60vh]">
        <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-[#F4F4F5] dark:border-[#18181B]">
          <h1 class="text-3xl sm:text-5xl font-bold text-[#0F0F11] dark:text-[#F4F4F5] leading-tight sm:leading-snug mb-6">{{ titleText }}</h1>
          <div class="flex flex-wrap items-center gap-5 text-[11px] sm:text-xs font-mono font-medium text-[#A1A1AA] uppercase">
            <time>{{ currentYear }}</time>
            <span class="text-[#D4D4D8] dark:text-[#3F3F46] font-light" aria-hidden="true">/</span>
            <span class="text-[#71717A] dark:text-[#A1A1AA] font-medium">MANIFESTO</span>
            <span class="text-[#D4D4D8] dark:text-[#3F3F46] font-light" aria-hidden="true">/</span>
            <span>README.MD</span>
          </div>
        </header>
        <div class="markdown-body markdown-renderer__body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap" role="article" aria-live="polite" data-markdown-renderer="wasm">
          {{ aboutContent }}
        </div>
      </article>
    </main>

    <footer class="w-full max-w-3xl mx-auto px-6 sm:px-8 pb-12 pt-8 sm:pb-16 border-t border-[#F4F4F5] dark:border-[#18181B] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
      <div class="text-sm text-[#8E8E93] dark:text-[#A1A1AA] font-medium tracking-normal select-none">
        &copy; {{ currentYear }} {{ siteTitleText }}. All rights reserved.
      </div>
      <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-[#8E8E93] dark:text-[#A1A1AA]">
        <a href="/api/Article/rss" class="rounded-[8px] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">RSS</a>
        <a href="#top" class="rounded-[8px] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors flex items-center gap-2 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
          <span>回到顶部</span>
          <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
        </a>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import type { PublicPassiveHydrationPayload } from './types'

const props = defineProps<PublicPassiveHydrationPayload>()
const currentYear = new Date().getFullYear()
const siteTitleText = props.siteTitle?.trim() || 'Fsus'
const titleText = props.title?.trim() || '关于'
const aboutContent = props.about?.content?.trim() || ''
</script>
