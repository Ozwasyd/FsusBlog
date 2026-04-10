<template>
  <div
    id="fsus-aot-shell"
    data-public-hydration-kind="ArticleDetail"
    class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white"
  >
    <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
        <div class="shrink-0">
          <a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">
            {{ siteTitleText }}<span class="text-zinc-400">.</span>
          </a>
        </div>

        <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
          <a href="/" class="mono-link">首页</a>
          <a href="/archive" class="mono-link">归档</a>
          <a href="/about" class="mono-link">关于</a>

          <form action="/search" method="get" class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
            <input
              type="text"
              name="q"
              placeholder="搜索"
              class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5"
              aria-label="搜索内容"
            />
          </form>

          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <a href="/login" class="mono-link">登录</a>
        </nav>
      </div>
    </header>

    <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
      <div class="max-w-3xl mx-auto min-h-screen">
        <article style="overflow-anchor: none;">
          <header :class="themeTokens.articleDetail.header">
            <h1 :class="themeTokens.articleDetail.title">
              {{ detailView.header.title }}
            </h1>

            <div :class="themeTokens.articleDetail.metaRow">
              <time
                :datetime="detailView.header.meta.isoTime"
                :title="detailView.header.meta.fullTime"
              >
                {{ detailView.header.meta.displayTime }}
              </time>
              <span :class="themeTokens.articleDetail.metaSeparator" aria-hidden="true">/</span>
              <a
                v-if="detailView.header.meta.categoryHref"
                :href="detailView.header.meta.categoryHref"
                :class="themeTokens.articleDetail.categoryLink"
                data-public-link="filter"
              >
                {{ detailView.header.meta.categoryName }}
              </a>
              <span v-else :class="themeTokens.articleDetail.categoryText">
                {{ detailView.header.meta.categoryName }}
              </span>
              <span :class="themeTokens.articleDetail.metaSeparator" aria-hidden="true">/</span>
              <span>{{ detailView.header.viewsText }}</span>
            </div>
          </header>

          <ArticleDetailBody>
            <div
              :class="[markdownSurfaceClasses.root, markdownSurfaceClasses.body]"
              role="article"
              aria-live="polite"
              data-markdown-renderer="wasm"
              v-html="detailView.body.content"
            ></div>
          </ArticleDetailBody>

          <footer
            v-if="detailView.header.tags.length > 0"
            class="mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-zinc-100"
          >
            <div :class="themeTokens.articleDetail.tagList">
              <a
                v-for="tag in detailView.header.tags"
                :key="tag.label"
                :href="`/tag/${tag.label.replace(/^#/, '')}`"
                :class="themeTokens.articleDetail.tagLink"
                data-public-link="filter"
              >
                {{ tag.label }}
              </a>
            </div>
          </footer>

          <section
            id="fsus-comments-island"
            :class="themeTokens.articleDetail.commentsRoot"
            :data-article-id="commentsIslandArticleId"
          >
            <h3 :class="themeTokens.articleDetail.commentsHeading">
              {{ detailView.comments.headingText }}
            </h3>
            <div :class="themeTokens.articleDetail.commentsPlaceholderRoot">
              <p :class="themeTokens.articleDetail.commentsPlaceholderTitle">
                {{ commentsIsland.placeholderTitle }}
              </p>
              <p :class="themeTokens.articleDetail.commentsPlaceholderBody">
                {{ commentsIsland.placeholderBody }}
              </p>
              <div class="mt-4 inline-flex items-center gap-2 text-zinc-400" aria-hidden="true">
                <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse"></span>
                <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse [animation-delay:120ms]"></span>
                <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse [animation-delay:240ms]"></span>
              </div>
              <p :class="themeTokens.articleDetail.commentsPlaceholderHint">
                {{ commentsIsland.placeholderHint }}
              </p>
            </div>
          </section>
        </article>
      </div>
    </main>

    <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
        <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">
          &copy; {{ currentYear }} {{ siteTitleText }}. All rights reserved.
        </div>

        <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500">
          <a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a>
          <a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group">
            <span>回到顶部</span>
            <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
          </a>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MARKDOWN_RENDERER_SURFACE_CLASSES as markdownSurfaceClasses } from '@wasm/markdown'
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'
import { emptyArticleDetailPageView } from '@/view-contracts/articleDetail'
import type { PublicArticleDetailHydrationPayload } from './types'

const props = defineProps<PublicArticleDetailHydrationPayload>()
const siteTitleText = computed(() => props.siteTitle?.trim() || 'Fsus')
const currentYear = new Date().getFullYear()
const detailView = computed(() => props.detailView ?? emptyArticleDetailPageView)
const commentsIsland = computed(() => props.commentsIsland ?? {
  articleId: props.articleId,
  placeholderTitle: detailView.value.comments.placeholderTitle,
  placeholderBody: detailView.value.comments.placeholderBody,
  placeholderHint: detailView.value.comments.placeholderHint
})
const commentsIslandArticleId = computed(() => String(commentsIsland.value.articleId ?? props.articleId ?? 0))
</script>
