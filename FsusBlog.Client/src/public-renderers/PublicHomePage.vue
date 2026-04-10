<template>
  <div
    id="fsus-aot-shell"
    data-public-hydration-kind="Home"
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
          <a href="/" class="mono-link active-link">首页</a>
          <a href="/archive" class="mono-link">归档</a>
          <a href="/about" class="mono-link">关于</a>

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
      <div class="flex flex-col lg:flex-row gap-12 lg:gap-24">
        <div class="grow lg:w-2/3">
          <header class="mb-12 sm:mb-20">
            <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">
              {{ siteTitleText }}<span class="text-zinc-400">.</span>
            </h1>
            <p class="mt-4 text-sm sm:text-base text-zinc-500 max-w-xl leading-relaxed">
              {{ siteDescriptionText }}
            </p>
          </header>

          <PublicArticleList
            :items="props.view.items"
            :pagination="props.view.pagination"
            :show-pagination="props.view.showPagination"
          />
        </div>

        <aside class="hidden lg:block lg:w-80 shrink-0 space-y-16 pt-8 lg:pt-0">
          <section class="public-aside-placeholder rounded-3xl border border-zinc-100 bg-zinc-50/60 px-6 py-8" aria-hidden="true">
            <h2 class="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">热门文章</h2>
            <div class="space-y-6">
              <div v-for="i in 5" :key="i" class="flex items-start gap-4">
                <div class="w-6 text-sm font-mono text-zinc-200">0{{ i }}</div>
                <div class="flex-1 space-y-2 pt-0.5">
                  <div class="h-3 rounded-sm bg-zinc-100"></div>
                  <div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div>
                </div>
              </div>
            </div>
          </section>
        </aside>
      </div>
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
import PublicArticleList from '@/components/public/PublicArticleList.vue'
import type { PublicHomeHydrationPayload } from './types'

const props = defineProps<PublicHomeHydrationPayload>()
const siteTitleText = computed(() => props.siteTitle?.trim() || 'Fsus')
const siteDescriptionText = computed(() => props.siteDescription?.trim() || '以极简形式呈现内容与思考。')
const currentYear = new Date().getFullYear()
</script>
