<template>
  <section
    v-if="articles.length > 0"
    class="home-text-first-recommendations mb-8 sm:mb-10 home-editorial-section"
    aria-labelledby="home-text-first-recommendations-title"
    data-home-editorial-secondary
  >
    <header class="home-editorial-section__header mb-4 border-b border-[var(--fsusblog-panel-border)] pb-3">
      <h2
        id="home-text-first-recommendations-title"
        class="text-xl font-bold leading-[1.2] tracking-normal text-[var(--fsusblog-text-primary)]"
      >
        {{ copy.eyebrow }}
      </h2>
    </header>

    <ol role="list" class="grid gap-3 sm:grid-cols-2 sm:gap-4">
      <li
        v-for="(article, index) in articles"
        :key="article.id"
        :data-article-id="article.id"
      >
        <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(article.id)">
          <a
            :href="href"
            class="group flex min-h-16 items-baseline gap-3 border-b border-[var(--fsusblog-panel-border)] pb-4 outline-none transition-colors"
            :class="focusRingClass"
            :aria-label="readFullLabel(article.title)"
            @click="navigate"
            @keydown.space.prevent="navigate()"
          >
            <span class="flex-none text-xs leading-5 tabular-nums font-medium text-[var(--fsusblog-text-muted)] group-hover:text-[var(--fsusblog-color-primary)]">
              {{ (index + 1).toString().padStart(2, '0') }}
            </span>
            <span class="min-w-0">
              <span class="block text-lg font-bold leading-[1.25] tracking-normal text-[var(--fsusblog-text-primary)] transition-colors group-hover:text-[var(--fsusblog-color-primary)]">
                {{ article.title }}
              </span>
              <span class="mt-1 block text-xs leading-4 tabular-nums font-medium normal-case text-[var(--fsusblog-text-muted)]">
                {{ viewCountText(article.views) }}
              </span>
            </span>
          </a>
        </RouterLink>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { PopularArticleSummaryResponse } from '@/api/article'
import { themeTokens } from '@/ui-tokens/themeTokens'
import { useI18nText } from '@/composables/useI18nText'

const { messages, translatePlural } = useI18nText()
const copy = computed(() => messages.value.layout.recommendations)

defineProps<{
  articles: readonly PopularArticleSummaryResponse[]
}>()

const focusRingClass = themeTokens.focusRing
const articleHref = (id: number) => `/article/${id}`
const viewCountText = (views: number) => translatePlural('layout.recommendations.viewCount', views)
const readFullLabel = (title: string) => copy.value.ariaReadFull.replace('{title}', title)
</script>
