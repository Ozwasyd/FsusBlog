<template>
  <div
    id="fsus-aot-shell"
    data-public-hydration-kind="Archive"
    class="font-sans min-h-screen flex flex-col bg-[var(--fsus-panel-bg)] text-[#0F0F11] subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-[#0F0F11] selection:text-white dark:bg-[#0F0F11] dark:text-[#FCFCFC] dark:selection:bg-[#F4F4F5] dark:selection:text-[#0F0F11]"
  >
    <header v-once class="w-full max-w-3xl mx-auto px-6 sm:px-8 pt-12 pb-8 sm:pt-20 sm:pb-10 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
      <a href="/" class="shrink-0 rounded-[8px] text-2xl sm:text-3xl font-bold hover:opacity-60 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">{{ siteTitleText }}<span class="text-[#A1A1AA]">.</span></a>
      <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
        <a href="/" class="mono-link">首页</a>
        <a href="/archive" class="mono-link active-link">归档</a>
        <a href="/about" class="mono-link">关于</a>
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

    <main class="fsus-page-shell grow max-w-3xl mx-auto w-full px-5 sm:px-8 pt-4 pb-20 sm:pb-32">
      <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-[#F4F4F5] dark:border-[#18181B]">
        <h1 class="text-3xl sm:text-5xl font-bold text-[#0F0F11] dark:text-[#F4F4F5] leading-tight sm:leading-snug mb-6">{{ titleText }}</h1>
        <div class="flex items-center gap-5 text-[11px] sm:text-xs font-mono font-medium text-[#A1A1AA] uppercase">
          <span>目前发布</span>
          <span class="text-[#D4D4D8] dark:text-[#3F3F46] font-light" aria-hidden="true">/</span>
          <span class="text-[#0F0F11] dark:text-[#F4F4F5] font-bold tabular-nums">{{ totalCount }}</span>
        </div>
      </header>

      <div v-if="yearGroups.length > 0" class="relative pb-24">
        <div class="absolute left-4.5 top-5 bottom-0 w-px bg-[#E4E4E7] dark:bg-[#3F3F46] z-0"></div>
        <div class="space-y-14 sm:space-y-16">
          <section
            v-for="(yearGroup, yearIndex) in yearGroups"
            :key="yearGroup.year"
            class="relative"
            :style="{ '--stagger': yearIndex }"
          >
            <div class="sticky top-20 z-10 bg-[var(--fsus-panel-bg)] dark:bg-[#0F0F11] py-3 mb-8 sm:mb-10 flex items-center">
              <div class="absolute left-0 w-9 h-9 bg-[var(--fsus-panel-bg)] dark:bg-[#0F0F11] flex items-center justify-center">
                <div class="w-2.5 h-2.5 rounded-full bg-[#0F0F11] dark:bg-[#F4F4F5] ring-4 ring-white dark:ring-[#0F0F11]"></div>
              </div>
              <h2 class="text-2xl sm:text-4xl font-bold text-[#0F0F11] dark:text-[#F4F4F5] pl-10 sm:pl-12 font-mono">{{ yearGroup.year }}</h2>
            </div>
            <div class="space-y-10 sm:space-y-12 pl-8 sm:pl-12">
              <div v-for="monthGroup in yearGroup.months" :key="monthGroup.month" class="relative">
                <h3 class="text-xs font-black text-[#A1A1AA] uppercase mb-6 flex items-center gap-6">
                  {{ monthGroup.month }}
                  <span class="h-px grow bg-[#F4F4F5]/80 dark:bg-[#27272A]/80" aria-hidden="true"></span>
                </h3>
                <div class="space-y-6">
                  <article
                    v-for="item in monthGroup.items"
                    :key="item.id"
                    v-memo="[item.id, item.title, item.day, item.fullTime]"
                    class="relative group"
                  >
                    <a :href="item.href" data-aot-action="open-article" :data-aot-id="item.id" class="rounded-[8px] flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 group py-1 sm:py-0 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
                      <time :datetime="item.fullTime" :title="item.fullTime" class="flex-none text-xs sm:text-sm font-mono text-[#A1A1AA] group-hover:text-[#2A599C] dark:group-hover:text-[#F4F4F5] transition-colors w-12 tabular-nums">{{ item.day }}</time>
                      <span class="safe-inline-wrap text-base sm:text-lg font-medium text-[#71717A] dark:text-[#D4D4D8] group-hover:text-[#2A599C] dark:group-hover:text-[#F4F4F5] transition-colors leading-snug border-b border-transparent group-hover:border-[#2A599C] dark:group-hover:border-[#F4F4F5] pb-0.5">{{ item.title }}</span>
                    </a>
                  </article>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div v-else class="ui-empty py-20">
        <p class="ui-empty-title text-sm font-medium uppercase text-[#A1A1AA] dark:text-[#8E8E93]">暂无文章归档</p>
      </div>
    </main>

    <footer v-once class="w-full max-w-3xl mx-auto px-6 sm:px-8 pb-12 pt-8 sm:pb-16 border-t border-[#F4F4F5] dark:border-[#18181B] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
      <div class="text-sm text-[#8E8E93] dark:text-[#A1A1AA] font-medium tracking-normal select-none">&copy; {{ currentYear }} {{ siteTitleText }}. All rights reserved.</div>
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
const siteTitleText = props.siteTitle?.trim() || 'Fsus'
const titleText = props.title?.trim() || '归档'
const totalCount = Number.isFinite(props.total) ? Number(props.total) : (props.articles?.length ?? 0)

const normalizedItems: ArchiveItem[] = (props.articles ?? [])
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

const byYear = new Map<string, ArchiveItem[]>()
for (const item of normalizedItems) {
  if (!byYear.has(item.year)) {
    byYear.set(item.year, [])
  }
  byYear.get(item.year)!.push(item)
}

const yearGroups = Array.from(byYear.entries()).map(([year, items]) => {
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
</script>
