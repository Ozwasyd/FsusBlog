<template>
  <section
    v-if="articles.length > 0"
    class="space-y-16"
    data-dynamic-island="home-hot-articles"
    data-home-hot-articles-aside
  >
    <div>
      <h2 class="text-xs font-bold text-[var(--fsusblog-text-muted)] normal-case mb-8">
        热门文章
      </h2>
      <ol role="list" class="space-y-6">
        <li
          v-for="(article, index) in articles.slice(0, 5)"
          :key="article.id"
          class="group flex items-start gap-6"
        >
          <span class="flex-none text-sm tabular-nums font-medium text-[var(--fsusblog-text-subtle)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors duration-[var(--fsus-motion-control)] w-6 pt-0.5">
            {{ String(index + 1).padStart(2, '0') }}
          </span>
          <div class="flex-auto flex flex-col gap-1.5">
            <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(article.id)">
              <a
                :href="href"
                class="rounded-[var(--fsusblog-reading-radius-control)] text-sm font-medium text-[var(--fsusblog-text-primary)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors duration-[var(--fsus-motion-control)] leading-relaxed line-clamp-2 outline-none"
                :class="focusRingClass"
                :aria-label="`阅读全文：${article.title}`"
                @click="navigate"
                @keydown.space.prevent="navigate()"
              >
                {{ article.title }}
              </a>
            </RouterLink>
            <p class="text-xs text-[var(--fsusblog-text-muted)] font-medium">
              {{ formatViews(article.views) }} 次打开
            </p>
          </div>
        </li>
      </ol>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PopularArticleSummaryResponse } from '@/api/article'
import { themeTokens } from '@/ui-tokens/themeTokens'

defineProps<{
  articles: PopularArticleSummaryResponse[]
}>()

const focusRingClass = themeTokens.focusRing
const articleHref = (id: number) => `/article/${id}`
const viewFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' })
const formatViews = (views: number) => viewFormatter.format(views)
</script>
