<template>
  <section class="featured-articles-section mb-20 animate-in fade-in slide-in-from-bottom-6 duration-[var(--fsus-motion-control-fast)]">
    <header class="mb-10">
      <div class="text-[10px] tabular-nums font-bold normal-case text-[var(--fsusblog-text-muted)]">
        聚焦 / SPOTLIGHT
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

    <div v-else-if="articles.length > 0 || hotArticles.length > 0" class="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-start">
      <div class="lg:col-span-8 space-y-16">
        <article v-if="articles[0]" class="relative">
          <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(articles[0].id)">
            <a
              :href="href"
              class="group flex flex-col gap-8 rounded-[var(--fsus-radius-panel)] outline-none md:flex-row md:items-center focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]"
              :aria-label="`阅读全文：${articles[0].title}`"
              @click="navigate"
              @keydown.space.prevent="navigate()"
            >
              <div class="w-full md:w-[50%] aspect-[4/3] overflow-hidden rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] shadow-none transition-[background-color,border-color,color,opacity,transform] duration-[var(--fsus-motion-control-fast)] group-hover:border-[var(--fsusblog-color-primary)]/20">
                <img
                  :src="articles[0].coverImageUrl"
                  :alt="articles[0].title"
                  class="blog-motion-media-hover h-full w-full object-cover"
                  loading="lazy"
                />
              </div>
              <div class="flex-1">
                <div class="mb-4 flex items-center gap-3">
                  <span class="text-[10px] tabular-nums font-bold normal-case text-[var(--fsusblog-text-primary)]">
                    {{ articles[0].category.name }}
                  </span>
                  <span class="h-px w-8 bg-[var(--fsusblog-panel-bg-soft)]" aria-hidden="true"></span>
                  <time :datetime="articles[0].createTime" class="text-[10px] tabular-nums text-[var(--fsusblog-text-muted)] normal-case">
                    {{ formatTime(articles[0].createTime) }}
                  </time>
                </div>
                <h2 class="text-2xl lg:text-3xl font-bold leading-tight text-[var(--fsusblog-text-primary)] transition-colors group-hover:text-[var(--fsusblog-color-primary)]">
                  {{ articles[0].title }}
                </h2>
                <div class="mt-8 flex items-center gap-2 text-[11px] font-bold normal-case text-[var(--fsusblog-text-muted)] transition-[background-color,border-color,color,opacity,transform] group-hover:text-[var(--fsusblog-color-primary)]">
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
                class="group block rounded-[var(--fsus-radius-panel)] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]"
                :aria-label="`阅读全文：${article.title}`"
                @click="navigate"
                @keydown.space.prevent="navigate()"
              >
                <div class="aspect-video w-full overflow-hidden rounded-[var(--fsus-radius-panel)] border border-[var(--fsusblog-panel-border)] mb-5 shadow-none transition-[background-color,border-color,color,opacity,transform] duration-[var(--fsus-motion-control-fast)] group-hover:border-[var(--fsusblog-color-primary)]/20">
                  <img
                    :src="article.coverImageUrl"
                    :alt="article.title"
                    class="blog-motion-media-hover h-full w-full object-cover"
                    loading="lazy"
                  />
                </div>
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-[9px] tabular-nums font-bold normal-case text-[var(--fsusblog-text-muted)]">
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

      <aside v-if="hotArticles.length > 0" class="lg:col-span-4 pt-4">
        <h3 class="text-[10px] font-bold normal-case text-[var(--fsusblog-text-muted)] mb-8 border-b border-[var(--fsusblog-panel-border)] pb-4">
          热门排行 / TRENDING
        </h3>
        <ul role="list" class="space-y-8">
          <li v-for="(article, index) in hotArticles" :key="article.id">
            <RouterLink v-slot="{ href, navigate }" custom :to="articleHref(article.id)">
              <a
                :href="href"
                class="group flex items-start gap-4 rounded-[var(--fsus-radius-control-small)] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--fsusblog-color-focus-ring)]"
                :aria-label="`打开热门文章第 ${index + 1} 位：${article.title}`"
                @click="navigate"
                @keydown.space.prevent="navigate()"
              >
                <span class="flex-none text-[11px] tabular-nums font-bold text-[var(--fsusblog-text-subtle)] pt-1 group-hover:text-[var(--fsusblog-color-primary)]">
                  {{ (index + 1).toString().padStart(2, '0') }}
                </span>
                <div class="min-w-0">
                  <h4 class="text-sm font-bold text-[var(--fsusblog-text-primary)] leading-snug line-clamp-2 transition-colors group-hover:text-[var(--fsusblog-color-primary)]">
                    {{ article.title }}
                  </h4>
                  <p class="mt-2 text-[10px] tabular-nums font-bold normal-case text-[var(--fsusblog-text-muted)] tabular-nums">
                    {{ formatViews(article.views) }} 浏览
                  </p>
                </div>
              </a>
            </RouterLink>
          </li>
        </ul>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight } from '@/fsusui/icons'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import { TimeUtils } from '@/utils/time'

defineProps<{
  articles: FeaturedArticleItem[]
  hotArticles: PopularArticleSummaryResponse[]
  loading?: boolean
}>()

const articleHref = (id: number) => `/article/${id}`

const formatTime = (isoString: string) => {
  return TimeUtils.toSmartTime(isoString)
}

const viewFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' })
const formatViews = (views: number) => viewFormatter.format(views)
</script>

<style scoped>
.line-clamp-2 {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
</style>
