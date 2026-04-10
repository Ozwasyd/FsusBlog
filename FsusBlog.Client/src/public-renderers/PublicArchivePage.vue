<template>
  <div
    id="fsus-aot-shell"
    data-public-hydration-kind="Archive"
    class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"
  >
    <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
        <div class="shrink-0">
          <a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">Fsus<span class="text-zinc-400">.</span></a>
        </div>
        <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
          <a href="/" class="mono-link">首页</a>
          <a href="/archive" class="mono-link active-link">归档</a>
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
      <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
        <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6">{{ titleText }}</h1>
        <div class="flex items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
          <span>目前发布</span>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span class="text-zinc-950 font-bold tabular-nums">{{ totalCount }}</span>
        </div>
      </header>

      <div v-if="yearGroups.length > 0" class="relative pb-24">
        <div class="absolute left-4.5 top-3 bottom-0 w-px bg-zinc-200 z-0"></div>
        <div class="space-y-20">
          <section
            v-for="(yearGroup, yearIndex) in yearGroups"
            :key="yearGroup.year"
            class="relative animate-in slide-in-from-bottom-4 fade-in duration-700"
            :style="{ '--stagger': yearIndex }"
          >
            <div class="sticky top-20 z-10 bg-white py-3 mb-10 flex items-center">
              <div class="absolute left-0 w-9 h-9 bg-white flex items-center justify-center">
                <div class="w-2.5 h-2.5 rounded-full bg-zinc-950 ring-4 ring-white"></div>
              </div>
              <h2 class="text-3xl sm:text-4xl font-bold text-zinc-950 pl-12 font-mono tracking-tighter">{{ yearGroup.year }}</h2>
            </div>
            <div class="space-y-14 pl-12">
              <div v-for="monthGroup in yearGroup.months" :key="monthGroup.month" class="relative">
                <h3 class="text-xs font-black tracking-[0.3em] text-zinc-400 uppercase mb-6 flex items-center gap-4">
                  {{ monthGroup.month }}
                  <span class="h-px grow bg-zinc-100/80" aria-hidden="true"></span>
                </h3>
                <div class="space-y-6">
                  <article v-for="item in monthGroup.items" :key="item.id" class="relative group">
                    <a :href="item.href" data-aot-action="open-article" :data-aot-id="item.id" class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 group py-1 sm:py-0 outline-none">
                      <time :datetime="item.fullTime" :title="item.fullTime" class="flex-none text-xs sm:text-sm font-mono text-zinc-400 group-hover:text-zinc-950 transition-colors w-12 tabular-nums">{{ item.day }}</time>
                      <span class="text-base sm:text-lg font-medium text-zinc-600 group-hover:text-zinc-950 transition-colors leading-snug border-b border-transparent group-hover:border-zinc-950 pb-0.5">{{ item.title }}</span>
                    </a>
                  </article>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div v-else class="ui-empty py-20 text-center">
        <p class="ui-empty-title text-sm font-medium tracking-widest uppercase text-zinc-400">暂无文章归档</p>
      </div>
    </main>

    <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
        <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">&copy; {{ currentYear }} Fsus. All rights reserved.</div>
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
import type { PublicArchiveHydrationPayload } from './types'

type ArchiveItem = {
  id: number
  title: string
  day: string
  month: string
  year: string
  fullTime: string
  href: string
  timestamp: number
}

const props = defineProps<PublicArchiveHydrationPayload>()
const currentYear = new Date().getFullYear()
const titleText = computed(() => props.title?.trim() || '归档')
const totalCount = computed(() => Number.isFinite(props.total) ? Number(props.total) : (props.articles?.length ?? 0))

const normalizedItems = computed<ArchiveItem[]>(() => {
  const source = props.articles ?? []
  return source
    .map((article) => {
      const id = Number(article.id ?? 0)
      const createdAt = article.createTime ? new Date(article.createTime) : null
      if (!id || !createdAt || Number.isNaN(createdAt.getTime())) {
        return null
      }

      const year = String(createdAt.getFullYear())
      const month = String(createdAt.getMonth() + 1).padStart(2, '0')
      const day = String(createdAt.getDate()).padStart(2, '0')
      const fullTime = `${year}-${month}-${day} ${String(createdAt.getHours()).padStart(2, '0')}:${String(createdAt.getMinutes()).padStart(2, '0')}:${String(createdAt.getSeconds()).padStart(2, '0')}`
      return {
        id,
        title: article.title ?? '',
        day,
        month,
        year,
        fullTime,
        href: `/article/${id}`,
        timestamp: createdAt.getTime()
      } satisfies ArchiveItem
    })
    .filter((item): item is ArchiveItem => Boolean(item))
    .sort((a, b) => b.timestamp - a.timestamp)
})

const yearGroups = computed(() => {
  const byYear = new Map<string, ArchiveItem[]>()
  for (const item of normalizedItems.value) {
    if (!byYear.has(item.year)) {
      byYear.set(item.year, [])
    }
    byYear.get(item.year)!.push(item)
  }

  return Array.from(byYear.entries()).map(([year, items]) => {
    const byMonth = new Map<string, ArchiveItem[]>()
    for (const item of items) {
      if (!byMonth.has(item.month)) {
        byMonth.set(item.month, [])
      }
      byMonth.get(item.month)!.push(item)
    }

    const months = Array.from(byMonth.entries())
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map(([month, monthItems]) => ({
        month,
        items: monthItems
      }))

    return {
      year,
      months
    }
  })
})
</script>
