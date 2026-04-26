<template>
  <div id="fsus-aot-shell" data-aot-page="Filter" data-public-hydration-kind="Filter" class="fsus-page-shell max-w-3xl mx-auto w-full px-5 sm:px-8 min-h-screen text-[#0F0F11] dark:text-[#FCFCFC] flex flex-col lg:flex-row gap-10 lg:gap-16 xl:gap-20 subpixel-antialiased">
      <main class="grow lg:w-2/3">
        <header class="mb-12 sm:mb-20 select-none">
          <p class="text-[10px] font-bold text-[#A1A1AA] uppercase mb-6">{{ label }}</p>
          <h1 class="text-3xl sm:text-4xl font-bold text-[#0F0F11] dark:text-[#F4F4F5]">{{ currentName }}</h1>
        </header>

        <div v-if="articles.length > 0" class="flex flex-col gap-10 sm:gap-14 lg:gap-16">
          <article
            v-for="article in articles"
            :key="article.id"
            v-memo="[article.id, article.title, article.summary, article.displayTime]"
            class="ui-article-card group flex flex-col items-start gap-5 sm:gap-6 subpixel-antialiased"
          >
            <div class="ui-article-meta flex flex-wrap items-center gap-5 text-[11px] sm:text-xs font-mono font-medium text-[#A1A1AA] uppercase">
              <time class="tabular-nums">{{ article.displayTime }}</time>
            </div>
            <h2 class="ui-article-title text-xl sm:text-2xl font-bold text-[#0F0F11] dark:text-[#F4F4F5] group-hover:text-[#8E8E93] dark:group-hover:text-[#D4D4D8] transition-colors duration-300 leading-snug">
              <a class="block rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]" :href="article.href" data-aot-action="open-article" :data-aot-id="article.id">{{ article.title }}</a>
            </h2>
            <p class="ui-article-summary text-sm sm:text-base text-[#71717A] dark:text-[#D4D4D8] leading-relaxed sm:leading-loose line-clamp-5">{{ article.summary }}</p>
            <a class="ui-article-link mt-2 rounded-[8px] text-[11px] sm:text-xs font-bold uppercase text-[#0F0F11] dark:text-[#F4F4F5] hover:text-[#2A599C] dark:hover:text-[#D4D4D8] transition-colors flex items-center gap-2 py-2 -ml-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]" :href="article.href" data-aot-action="open-article" :data-aot-id="article.id">阅读<span aria-hidden="true">→</span></a>
          </article>
        </div>

        <div v-else class="py-24 sm:py-32">
          <p class="text-[11px] font-mono text-[#D4D4D8] dark:text-[#71717A] uppercase">无相关内容</p>
        </div>

        <nav v-if="totalPages > 1" class="mt-16 sm:mt-20 pt-8 sm:pt-10 border-t border-[#F4F4F5] dark:border-[#18181B] flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-4 select-none" aria-label="文章分页">
          <button class="rounded-[8px] text-[10px] font-bold uppercase transition-all duration-300 text-[#A1A1AA] dark:text-[#8E8E93] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] py-4 px-3 min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]" :class="{ 'opacity-10 cursor-not-allowed': !canPrev }" data-aot-action="page-prev" :disabled="!canPrev" :aria-disabled="String(!canPrev)">← <span class="hidden xs:inline ml-2">上一页</span></button>
          <span class="text-[10px] font-mono font-bold text-[#A1A1AA] tabular-nums">{{ indicator }}</span>
          <button class="rounded-[8px] text-[10px] font-bold uppercase transition-all duration-300 text-[#A1A1AA] dark:text-[#8E8E93] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] py-4 px-3 min-h-11 outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]" :class="{ 'opacity-10 cursor-not-allowed': !canNext }" data-aot-action="page-next" :disabled="!canNext" :aria-disabled="String(!canNext)"><span class="hidden xs:inline mr-2">下一页</span> →</button>
        </nav>
      </main>

      <aside class="hidden lg:block lg:w-64 shrink-0">
        <a href="/" class="sticky top-52 rounded-[8px] text-[10px] font-bold uppercase text-[#A1A1AA] dark:text-[#8E8E93] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors flex items-center gap-5 group outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
          <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span> 回到主页
        </a>
      </aside>
  </div>
</template>

<script setup lang="ts">
import type { PublicFilterHydrationPayload } from './types'

const props = defineProps<PublicFilterHydrationPayload>()

const routeKey = props.routeKey ?? 'filter:unknown'
const label = routeKey.startsWith('category:') ? '分类' : routeKey.startsWith('tag:') ? '标签' : '筛选'
const currentName = (() => {
  if (routeKey.startsWith('category:')) {
    const id = routeKey.replace('category:', '').trim()
    return id ? `分类 #${id}` : '分类'
  }
  if (routeKey.startsWith('tag:')) {
    const id = routeKey.replace('tag:', '').trim()
    return id ? `标签 #${id}` : '标签'
  }
  return props.title?.trim() || '筛选'
})()

const pageIndex = Number(props.filter?.pageIndex ?? 1)
const pageSize = Math.max(1, Number(props.filter?.pageSize ?? 10))
const total = Math.max(0, Number(props.filter?.total ?? 0))
const totalPages = Math.max(1, Math.ceil(total / pageSize))
const canPrev = pageIndex > 1
const canNext = pageIndex < totalPages
const indicator = `${String(pageIndex).padStart(2, '0')} / ${String(totalPages).padStart(2, '0')}`

const articles = (props.filter?.articles ?? []).map((article) => {
  const id = Number(article.id ?? 0)
  const created = article.createTime ? new Date(article.createTime) : null
  const displayTime = created && !Number.isNaN(created.getTime())
    ? `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`
    : ''

  return {
    id,
    href: `/article/${id}`,
    title: article.title ?? '',
    summary: article.summary ?? '',
    displayTime
  }
})
</script>
