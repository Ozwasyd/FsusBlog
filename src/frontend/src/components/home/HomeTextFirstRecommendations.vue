<template>
  <section
    v-if="articles.length > 0"
    class="home-text-first-recommendations mb-16 sm:mb-20"
    aria-labelledby="home-text-first-recommendations-title"
  >
    <header class="mb-8 border-b border-[var(--fsusblog-panel-border)] pb-4">
      <div
        id="home-text-first-recommendations-title"
        class="text-[10px] tabular-nums font-bold normal-case text-[var(--fsusblog-text-muted)]"
      >
        顺着读
      </div>
    </header>

    <ol role="list" class="grid gap-5 sm:grid-cols-2">
      <li v-for="(article, index) in articles" :key="article.id">
        <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(article.id)">
          <a
            :href="href"
            class="group flex min-h-24 items-start gap-4 border-b border-[var(--fsusblog-panel-border)] pb-5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]"
            :aria-label="`阅读全文：${article.title}`"
            @click="navigate"
            @keydown.space.prevent="navigate()"
          >
            <span class="mt-1 flex-none text-[11px] tabular-nums font-bold text-[var(--fsusblog-text-subtle)] group-hover:text-[var(--fsusblog-color-primary)]">
              {{ (index + 1).toString().padStart(2, '0') }}
            </span>
            <span class="min-w-0">
              <span class="block text-sm font-bold leading-snug text-[var(--fsusblog-text-primary)] transition-colors group-hover:text-[var(--fsusblog-color-primary)]">
                {{ article.title }}
              </span>
              <span class="mt-3 block text-[10px] tabular-nums font-bold normal-case text-[var(--fsusblog-text-muted)]">
                {{ formatViews(article.views) }} 次打开
              </span>
            </span>
          </a>
        </RouterLink>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import type { PopularArticleSummaryResponse } from '@/api/article'

defineProps<{
  articles: PopularArticleSummaryResponse[]
}>()

const articleHref = (id: number) => `/article/${id}`
const viewFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' })
const formatViews = (views: number) => viewFormatter.format(views)
</script>
