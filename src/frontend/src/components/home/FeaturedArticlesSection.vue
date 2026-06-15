<template>
  <section
    v-if="loading || articles.length > 0"
    class="featured-articles-section mb-20"
    data-fsus-motion-surface="home-featured-articles"
  >
    <header class="mb-10">
      <div class="text-xs tabular-nums font-semibold normal-case text-[var(--fsusblog-text-muted)]">
        聚焦
      </div>
    </header>

    <el-skeleton v-if="loading" animated>
      <template #template>
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16">
          <div class="lg:col-span-8 space-y-12">
            <div class="flex flex-col md:flex-row gap-8 items-center">
              <div class="w-full md:w-[50%] aspect-[4/3]">
                <el-skeleton-item variant="image" />
              </div>
              <div class="flex-1 space-y-4">
                <div class="h-4 w-24">
                  <el-skeleton-item variant="text" />
                </div>
                <div class="h-10 w-full">
                  <el-skeleton-item variant="h3" />
                </div>
                <div class="h-10 w-2/3">
                  <el-skeleton-item variant="h3" />
                </div>
              </div>
            </div>
          </div>

          <div class="lg:col-span-4 space-y-8">
            <div v-for="i in 5" :key="i" class="flex gap-4">
              <div class="w-6 h-4">
                <el-skeleton-item variant="text" />
              </div>
              <div class="flex-1 h-4">
                <el-skeleton-item variant="text" />
              </div>
            </div>
          </div>
        </div>
      </template>
    </el-skeleton>

    <div v-else class="space-y-16">
      <div class="space-y-16">
        <article v-if="articles[0]" class="relative">
          <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(articles[0].id)">
            <a
              :href="href"
              class="group flex flex-col gap-8 rounded-[var(--fsusblog-reading-radius-panel)] outline-none md:flex-row md:items-center"
              :class="focusRingClass"
              :aria-label="`阅读全文：${articles[0].title}`"
              @click="navigate"
              @keydown.space.prevent="navigate()"
            >
              <div class="w-full md:w-[50%] aspect-[4/3] overflow-hidden rounded-[var(--fsusblog-reading-radius-media)] border border-[var(--fsusblog-panel-border)] shadow-none transition-[background-color,border-color,color,opacity,transform] duration-[var(--fsus-motion-control-fast)] group-hover:border-[var(--fsusblog-color-primary)]/20">
                <img
                  :src="articles[0].coverImageUrl"
                  :alt="articles[0].title"
                  class="h-full w-full object-cover"
                  width="960"
                  height="720"
                  sizes="(min-width: 768px) 32rem, calc(100vw - 3rem)"
                  loading="lazy"
                  decoding="async"
                />
              </div>
              <div class="flex-1">
                <div class="mb-4 flex items-center gap-3">
                  <span class="text-xs tabular-nums font-semibold normal-case text-[var(--fsusblog-text-primary)]">
                    {{ articles[0].category.name }}
                  </span>
                  <span class="h-px w-8 bg-[var(--fsusblog-panel-bg-soft)]" aria-hidden="true"></span>
                  <time :datetime="articles[0].createTime" class="text-xs tabular-nums text-[var(--fsusblog-text-muted)] normal-case">
                    {{ formatTime(articles[0].createTime) }}
                  </time>
                </div>
                <h2 class="text-2xl lg:text-3xl font-bold leading-tight text-[var(--fsusblog-text-primary)] transition-colors group-hover:text-[var(--fsusblog-color-primary)]">
                  {{ articles[0].title }}
                </h2>
                <div class="mt-8 flex items-center gap-2 text-xs font-semibold normal-case text-[var(--fsusblog-text-muted)] transition-[background-color,border-color,color,opacity,transform] group-hover:text-[var(--fsusblog-color-primary)]">
                  阅读全文 <el-icon aria-hidden="true"><ArrowRight /></el-icon>
                </div>
              </div>
            </a>
          </RouterLink>
        </article>

        <div v-if="articles.length > 1" class="grid grid-cols-1 sm:grid-cols-2 gap-8">
          <article
            v-for="article in articles.slice(1, 3)"
            :key="article.id"
          >
            <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(article.id)">
              <a
                :href="href"
                class="group block rounded-[var(--fsusblog-reading-radius-panel)] outline-none"
                :class="focusRingClass"
                :aria-label="`阅读全文：${article.title}`"
                @click="navigate"
                @keydown.space.prevent="navigate()"
              >
                <div class="aspect-video w-full overflow-hidden rounded-[var(--fsusblog-reading-radius-media)] border border-[var(--fsusblog-panel-border)] mb-5 shadow-none transition-[background-color,border-color,color,opacity,transform] duration-[var(--fsus-motion-control-fast)] group-hover:border-[var(--fsusblog-color-primary)]/20">
                  <img
                    :src="article.coverImageUrl"
                    :alt="article.title"
                    class="h-full w-full object-cover"
                    width="960"
                    height="540"
                    sizes="(min-width: 640px) 20rem, calc(100vw - 3rem)"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-xs tabular-nums font-semibold normal-case text-[var(--fsusblog-text-muted)]">
                    {{ article.category.name }}
                  </span>
                </div>
                <h3 class="text-base font-bold leading-snug text-[var(--fsusblog-text-primary)] transition-colors group-hover:text-[var(--fsusblog-color-primary)]">
                  {{ article.title }}
                </h3>
              </a>
            </RouterLink>
          </article>
        </div>
      </div>

    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight } from '@/fsusui/icons'
import type { FeaturedArticleItem } from '@/api/article'
import { themeTokens } from '@/ui-tokens/themeTokens'
import { TimeUtils } from '@/utils/time'

defineProps<{
  articles: FeaturedArticleItem[]
  loading?: boolean
}>()

const focusRingClass = themeTokens.focusRing
const articleHref = (id: number) => `/article/${id}`

const formatTime = (isoString: string) => {
  return TimeUtils.toSmartTime(isoString)
}
</script>

<style scoped>
.line-clamp-2 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
</style>
