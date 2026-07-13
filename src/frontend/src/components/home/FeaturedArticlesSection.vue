<template>
  <section
    v-if="loading || article"
    class="featured-articles-section mb-12 sm:mb-16"
    data-fsus-surface="reading"
    data-fsus-motion-surface="home-featured-article"
    :aria-labelledby="article ? 'home-editorial-lead-title' : undefined"
    :aria-label="!article && loading ? copy.leadLoadingLabel : undefined"
  >
    <header class="mb-5 border-b border-[var(--fsusblog-panel-border)] pb-3">
      <div class="text-xs tabular-nums font-semibold normal-case text-[var(--fsusblog-text-muted)]">
        {{ copy.leadEyebrow }}
      </div>
    </header>

    <el-skeleton
      v-if="loading"
      style="--el-skeleton-color: var(--fsusblog-skeleton-bg); --el-skeleton-to-color: var(--fsusblog-skeleton-bg)"
    >
      <template #template>
        <div class="grid gap-8 md:grid-cols-2 md:items-center">
          <div class="aspect-video w-full overflow-hidden rounded-[var(--fsusblog-reading-radius-media)] md:aspect-[4/3]">
            <el-skeleton-item variant="image" />
          </div>
          <div class="space-y-4">
            <div class="h-4 w-28"><el-skeleton-item variant="text" /></div>
            <div class="h-10 w-full"><el-skeleton-item variant="h3" /></div>
            <div class="h-10 w-2/3"><el-skeleton-item variant="h3" /></div>
          </div>
        </div>
      </template>
    </el-skeleton>

    <article
      v-else-if="article"
      class="home-editorial-lead"
      data-home-editorial-lead
      :data-article-id="article.id"
      :data-home-lead-layout="hasCover ? 'media' : 'text'"
    >
      <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(article.id)">
        <a
          :href="href"
          class="group grid rounded-[var(--fsusblog-reading-radius-panel)] outline-none"
          :class="[
            focusRingClass,
            hasCover
              ? 'gap-8 md:grid-cols-2 md:items-center'
              : 'border-y border-[var(--fsusblog-panel-border)] py-8 sm:py-10'
          ]"
          :aria-label="readFullLabel(article.title)"
          @click="navigate"
          @keydown.space.prevent="navigate()"
        >
          <div
            v-if="hasCover"
            class="aspect-video w-full overflow-hidden rounded-[var(--fsusblog-reading-radius-media)] border border-[var(--fsusblog-panel-border)] shadow-none md:aspect-[4/3]"
            data-content-cover="editorial-lead"
            :data-cover-safe-area="coverPresentation?.safeArea"
          >
            <img
              :src="coverPresentation?.url"
              :alt="article.title"
              class="h-full w-full object-cover object-center shadow-none"
              :style="{ objectPosition: coverPresentation?.objectPosition }"
              width="960"
              height="720"
              sizes="(min-width: 768px) 23rem, calc(100vw - 3rem)"
              loading="eager"
              fetchpriority="high"
              decoding="async"
            />
          </div>

          <div :class="hasCover ? '' : 'max-w-3xl'">
            <div class="mb-4 flex flex-wrap items-center gap-3">
              <span class="text-xs tabular-nums font-semibold normal-case text-[var(--fsusblog-text-primary)]">
                {{ article.category.name }}
              </span>
              <span class="h-px w-8 bg-[var(--fsusblog-panel-border)]" aria-hidden="true" />
              <time
                :datetime="article.createTime"
                class="text-xs tabular-nums normal-case text-[var(--fsusblog-text-muted)]"
              >
                {{ formatTime(article.createTime) }}
              </time>
            </div>
            <h1
              id="home-editorial-lead-title"
              class="text-2xl font-bold leading-tight text-[var(--fsusblog-text-primary)] transition-colors duration-[var(--fsus-motion-control-fast)] group-hover:text-[var(--fsusblog-color-primary)] sm:text-3xl"
            >
              {{ article.title }}
            </h1>
          </div>
        </a>
      </RouterLink>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { FeaturedArticleItem } from '@/api/article'
import { FSUSBLOG_LAYOUT_COPY } from '@/copy'
import { themeTokens } from '@/ui-tokens/themeTokens'
import { resolvePublicCoverPresentation } from '@/view-contracts/coverArt'

const props = defineProps<{
  article: FeaturedArticleItem | null
  loading?: boolean
}>()

const focusRingClass = themeTokens.focusRing
const copy = FSUSBLOG_LAYOUT_COPY.recommendations
const coverPresentation = computed(() => resolvePublicCoverPresentation(props.article?.coverImageUrl))
const hasCover = computed(() => coverPresentation.value !== null)
const articleHref = (id: number) => `/article/${id}`
const readFullLabel = (title: string): string => copy.ariaReadFull.replace('{title}', title)

const formatTime = (isoString: string): string => {
  const normalized = String(isoString ?? '').trim()
  return normalized.length >= 10 ? normalized.slice(0, 10) : '-'
}
</script>

<style scoped>
@media (prefers-reduced-motion: reduce) {
  .home-editorial-lead a,
  .home-editorial-lead h1 {
    transition-duration: 1ms;
  }
}
</style>
