<template>
  <div id="fsus-aot-shell" data-aot-page="Filter" data-public-hydration-kind="Filter" class="max-w-3xl mx-auto w-full px-6 sm:px-8 min-h-screen">
    <div class="flex flex-col lg:flex-row gap-12 lg:gap-24 subpixel-antialiased">
      <div class="grow lg:w-2/3">
        <header class="mb-12 sm:mb-20 select-none">
          <p class="text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4 animate-in fade-in duration-700">{{ label }}</p>
          <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950 animate-in fade-in slide-in-from-bottom-3 duration-1000">{{ currentName }}</h1>
        </header>

        <div v-if="articles.length > 0" class="flex flex-col gap-12 sm:gap-20">
          <article v-for="article in articles" :key="article.id" class="ui-article-card group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased animate-fade-in">
            <div class="ui-article-meta flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
              <time class="tabular-nums">{{ article.displayTime }}</time>
            </div>
            <h2 class="ui-article-title text-xl sm:text-2xl font-bold text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-snug">
              <a class="block" :href="article.href" data-aot-action="open-article" :data-aot-id="article.id">{{ article.title }}</a>
            </h2>
            <p class="ui-article-summary text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3">{{ article.summary }}</p>
            <a class="ui-article-link mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5" :href="article.href" data-aot-action="open-article" :data-aot-id="article.id">阅读<span aria-hidden="true">→</span></a>
          </article>
        </div>

        <div v-else class="py-32 text-center">
          <p class="text-[11px] font-mono text-zinc-300 uppercase tracking-widest">无相关内容</p>
        </div>

        <nav v-if="totalPages > 1" class="mt-24 pt-12 border-t border-zinc-100 flex justify-between items-center select-none" aria-label="文章分页">
          <button class="text-[10px] font-bold tracking-[0.2em] uppercase transition-all duration-300 text-zinc-400 hover:text-zinc-950 py-4 outline-none focus-visible:ring-1 focus-visible:ring-zinc-950" :class="{ 'opacity-10 cursor-not-allowed': !canPrev }" data-aot-action="page-prev" :disabled="!canPrev" :aria-disabled="String(!canPrev)">← <span class="hidden xs:inline ml-2">上一页</span></button>
          <span class="text-[10px] font-mono font-bold text-zinc-400 tracking-widest tabular-nums">{{ indicator }}</span>
          <button class="text-[10px] font-bold tracking-[0.2em] uppercase transition-all duration-300 text-zinc-400 hover:text-zinc-950 py-4 outline-none focus-visible:ring-1 focus-visible:ring-zinc-950" :class="{ 'opacity-10 cursor-not-allowed': !canNext }" data-aot-action="page-next" :disabled="!canNext" :aria-disabled="String(!canNext)"><span class="hidden xs:inline mr-2">下一页</span> →</button>
        </nav>
      </div>

      <aside class="hidden lg:block lg:w-64 shrink-0">
        <div class="sticky top-32">
          <a href="/" class="text-[10px] font-bold tracking-[0.2em] uppercase text-zinc-400 hover:text-zinc-950 transition-colors flex items-center gap-3 group">
            <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span> 回到主页
          </a>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PublicFilterHydrationPayload } from './types'

const props = defineProps<PublicFilterHydrationPayload>()

const routeKey = computed(() => props.routeKey ?? 'filter:unknown')
const label = computed(() => routeKey.value.startsWith('category:') ? '分类' : routeKey.value.startsWith('tag:') ? '标签' : '筛选')
const currentName = computed(() => {
  if (routeKey.value.startsWith('category:')) {
    const id = routeKey.value.replace('category:', '').trim()
    return id ? `分类 #${id}` : '分类'
  }
  if (routeKey.value.startsWith('tag:')) {
    const id = routeKey.value.replace('tag:', '').trim()
    return id ? `标签 #${id}` : '标签'
  }
  return props.title?.trim() || '筛选'
})

const pageIndex = computed(() => Number(props.filter?.pageIndex ?? 1))
const pageSize = computed(() => Math.max(1, Number(props.filter?.pageSize ?? 10)))
const total = computed(() => Math.max(0, Number(props.filter?.total ?? 0)))
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const canPrev = computed(() => pageIndex.value > 1)
const canNext = computed(() => pageIndex.value < totalPages.value)
const indicator = computed(() => `${String(pageIndex.value).padStart(2, '0')} / ${String(totalPages.value).padStart(2, '0')}`)

const articles = computed(() => {
  return (props.filter?.articles ?? []).map((article) => {
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
})
</script>
