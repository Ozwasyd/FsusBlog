<template>
  <section class="blog-page-shell max-w-4xl mx-auto px-6 sm:px-12 min-h-screen">
    <el-skeleton v-if="loading" animated aria-hidden="true">
      <template #template>
        <div class="py-24 space-y-16 sm:space-y-20">
          <div v-for="i in 3" :key="i" class="space-y-10">
            <div class="h-12 w-32">
              <el-skeleton-item variant="h3" />
            </div>
            <div class="space-y-6">
              <div v-for="j in 4" :key="j" class="h-6 w-full">
                <el-skeleton-item variant="text" />
              </div>
            </div>
          </div>
        </div>
      </template>
    </el-skeleton>

    <div v-else class="relative pb-32 pt-16 sm:pt-24">
      <header class="mb-16 border-b border-[var(--fsusblog-panel-border)] pb-10 sm:mb-20 sm:pb-12">
        <h1 class="mb-6 text-3xl font-bold tracking-normal text-[var(--fsusblog-text-primary)] sm:text-4xl">
          归档
        </h1>
        <div class="flex items-center gap-6 text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
          <span>已发布 <span class="text-[var(--fsusblog-text-primary)] tabular-nums">{{ view.total }}</span> 篇</span>
        </div>
        <nav
          v-if="view.yearGroups.length > 1"
          class="mt-10 flex flex-wrap gap-3"
          aria-label="年份快速导航"
        >
          <a
            v-for="yearGroup in view.yearGroups"
            :key="`quick-${yearGroup.year}`"
            :href="`#archive-year-${yearGroup.year}`"
            class="rounded-[var(--fsus-radius-control-small)] px-1 py-1 text-xs font-semibold tabular-nums text-[var(--fsusblog-text-secondary)] underline-offset-4 hover:text-[var(--fsusblog-color-primary)] hover:underline focus-visible:outline-none"
            :class="focusRingClass"
          >
            {{ yearGroup.year }}
          </a>
        </nav>
      </header>

      <div class="space-y-16 sm:space-y-20">
        <section
          v-for="yearGroup in view.yearGroups"
          :key="yearGroup.year"
          :id="`archive-year-${yearGroup.year}`"
          class="relative"
        >
          <div class="sticky top-24 z-10 bg-[var(--fsusblog-page-bg)] py-6 mb-12 sm:mb-16 border-b border-[var(--fsusblog-panel-border)]/50">
            <h2 class="text-2xl font-bold text-[var(--fsusblog-text-primary)] tabular-nums tracking-normal sm:text-3xl">
              {{ yearGroup.year }}
            </h2>
          </div>

          <div class="space-y-16 sm:space-y-20">
            <div
              v-for="monthGroup in yearGroup.months"
              :key="monthGroup.month"
              class="relative"
            >
              <h3 class="mb-8 flex items-center gap-8 text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-subtle)]">
                {{ monthGroup.monthLabel }}
                <span class="h-px grow bg-[var(--fsusblog-panel-bg-soft)]" aria-hidden="true"></span>
              </h3>

              <div class="space-y-8 sm:space-y-10">
                <article
                  v-for="article in monthGroup.items"
                  :key="article.id"
                  class="blog-motion-state-change relative group"
                >
                  <a
                    :href="`/article/${article.route.params.id}`"
                    data-public-link="article"
                    class="flex flex-col sm:flex-row sm:items-baseline gap-4 sm:gap-10 group outline-none"
                    @click="handleNavigate($event, article.route.params.id)"
                  >
                    <time
                      :datetime="article.createTime"
                      :title="article.fullLocalTimeText"
                      class="flex-none text-xs tabular-nums font-semibold text-[var(--fsusblog-text-subtle)] group-hover:text-[var(--fsusblog-color-primary)] transition-colors w-12"
                    >
                      {{ article.dayText }}
                    </time>

                    <span class="safe-inline-wrap text-lg sm:text-xl font-medium text-[var(--fsusblog-text-tertiary)] group-hover:text-[var(--fsusblog-text-primary)] transition-[background-color,border-color,color,opacity,transform] leading-tight border-b border-transparent group-hover:border-[var(--fsusblog-color-primary)] pb-1">
                      {{ article.title }}
                    </span>
                  </a>
                </article>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div v-if="view.yearGroups.length === 0" class="py-24 sm:py-32 md:py-48 text-center">
        <p class="text-xs tabular-nums font-semibold text-[var(--fsusblog-text-subtle)] normal-case tracking-normal">
          {{ view.emptyState.title }}
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ArchivePageViewContract } from '@/view-contracts/archive'
import { themeTokens } from '@/ui-tokens/themeTokens'

const props = defineProps<{
  loading?: boolean
  view: ArchivePageViewContract
  spaNavigation?: boolean
}>()

const emit = defineEmits<{
  (event: 'navigate', href: string): void
}>()

const focusRingClass = themeTokens.focusRing

function handleNavigate(event: MouseEvent, articleId: string): void {
  if (!props.spaNavigation) {
    return
  }

  event.preventDefault()
  emit('navigate', `/article/${articleId}`)
}
</script>

<style scoped>
@reference "@/assets/main.css";

@media (max-width: 640px) {
  .sticky { top: 64px; }
}

.tabular-nums { font-variant-numeric: tabular-nums; }
</style>
