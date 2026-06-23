<template>
  <section
    v-if="articles.length > 0"
    class="home-text-first-recommendations mb-8 sm:mb-10"
    aria-labelledby="home-text-first-recommendations-title"
  >
    <header class="mb-4 border-b border-[var(--fsusblog-panel-border)] pb-3">
      <div
        id="home-text-first-recommendations-title"
        class="text-xs tabular-nums font-bold normal-case text-[var(--fsusblog-text-muted)]"
      >
        {{ copy.eyebrow }}
      </div>
    </header>

    <ol role="list" class="grid gap-3 sm:grid-cols-2 sm:gap-4">
      <li v-for="(article, index) in articles" :key="article.id">
        <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(article.id)">
          <a
            :href="href"
            class="group flex min-h-16 items-start gap-3 border-b border-[var(--fsusblog-panel-border)] pb-4 outline-none transition-colors"
            :class="focusRingClass"
            :aria-label="readFullLabel(article.title)"
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
              <span class="mt-2 block text-[10px] tabular-nums font-bold normal-case text-[var(--fsusblog-text-muted)]">
                {{ formatViews(article.views) }} {{ copy.viewsUnit }}
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
import { themeTokens } from '@/ui-tokens/themeTokens'
import { FSUSBLOG_LAYOUT_COPY } from '@/copy'

const copy = FSUSBLOG_LAYOUT_COPY.recommendations

defineProps<{
  articles: PopularArticleSummaryResponse[]
}>()

const focusRingClass = themeTokens.focusRing
const articleHref = (id: number) => `/article/${id}`
const viewFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' })
const formatViews = (views: number) => viewFormatter.format(views)
const readFullLabel = (title: string) => copy.ariaReadFull.replace('{title}', title)
</script>