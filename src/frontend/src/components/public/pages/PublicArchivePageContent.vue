<template>
  <PublicReadingPageFrame as="section">
    <el-skeleton
      v-if="loading"
      aria-hidden="true"
      style="--el-skeleton-color: var(--fsusblog-skeleton-bg); --el-skeleton-to-color: var(--fsusblog-skeleton-bg)"
    >
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

    <div v-else class="relative">
      <header class="mb-10 border-b border-[var(--fsusblog-panel-border)] pb-6 sm:mb-12 sm:pb-8">
        <h1 class="mb-6 text-3xl font-bold tracking-normal text-[var(--fsusblog-text-heading)] sm:text-4xl">
          归档
        </h1>
        <div class="flex items-center gap-6 text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
          <span>已发布 <span class="text-[var(--fsusblog-text-primary)] tabular-nums">{{ view.total }}</span> 篇</span>
        </div>
        <nav
          v-if="view.yearGroups.length > 1"
          class="mt-6 flex flex-wrap gap-3"
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

      <div v-if="view.yearGroups.length > 0" class="space-y-12 pb-24 sm:space-y-16">
        <section
          v-for="yearGroup in view.yearGroups"
          :key="yearGroup.year"
          :id="`archive-year-${yearGroup.year}`"
          class="archive-year-section relative"
        >
          <div class="archive-year-heading sticky z-10 bg-[var(--fsusblog-page-bg)] pt-2 pb-3 mb-8 sm:mb-10 flex items-baseline gap-3">
            <span class="text-[var(--fsusblog-text-subtle)] leading-none" aria-hidden="true">·</span>
            <h2 class="text-2xl font-bold text-[var(--fsusblog-text-heading)] tabular-nums tracking-normal sm:text-3xl">
              {{ yearGroup.year }}
            </h2>
          </div>

          <div class="space-y-10 sm:space-y-12">
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

                    <span class="safe-inline-wrap blog-link-underline text-lg sm:text-xl font-medium text-[var(--fsusblog-text-tertiary)] group-hover:text-[var(--fsusblog-text-primary)] transition-colors leading-tight">
                      {{ article.title }}
                    </span>
                  </a>
                </article>
              </div>
            </div>
          </div>
        </section>
      </div>

      <PublicContentState
        v-else
        :title="view.emptyState.title"
        description="发布后的内容会显示在这里。"
        size="page"
        role="status"
        aria-live="polite"
      />
    </div>
  </PublicReadingPageFrame>
</template>

<script setup lang="ts">
import PublicContentState from '@/components/public/PublicContentState.vue'
import PublicReadingPageFrame from '@/components/public/PublicReadingPageFrame.vue'
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

.archive-year-section {
  scroll-margin-top: var(--fsusblog-public-anchor-offset, calc(var(--fsusblog-public-header-height, 4rem) + 3.5rem));
}

.archive-year-heading {
  top: var(--fsusblog-public-sticky-top, var(--fsusblog-public-header-height, 4rem));
}

.tabular-nums { font-variant-numeric: tabular-nums; }
</style>
