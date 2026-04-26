<template>
  <div
    id="fsus-aot-shell"
    data-public-hydration-kind="ArticleDetail"
    class="font-sans min-h-screen flex flex-col bg-[var(--fsus-panel-bg)] text-[#0F0F11] subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-[#0F0F11] selection:text-white dark:bg-[#0F0F11] dark:text-[#FCFCFC] dark:selection:bg-[#F4F4F5] dark:selection:text-[#0F0F11]"
  >
    <header v-once class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
        <div class="shrink-0">
          <a href="/" class="rounded-[8px] text-2xl sm:text-3xl font-bold hover:opacity-60 transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
            {{ siteTitleText }}<span class="text-[#A1A1AA]">.</span>
          </a>
        </div>

        <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
          <a href="/" class="mono-link">首页</a>
          <a href="/archive" class="mono-link">归档</a>
          <a href="/about" class="mono-link">关于</a>

          <form action="/search" method="get" class="hidden sm:flex items-center group border-b border-[#F4F4F5] dark:border-[#27272A] focus-within:border-[#2A599C] transition-colors duration-300">
            <input
              type="text"
              name="q"
              placeholder="搜索"
              class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-[#D4D4D8] text-[#8E8E93] dark:placeholder:text-[#71717A] dark:text-[#A1A1AA] focus:text-[#0F0F11] dark:focus:text-[#F4F4F5] pb-0.5"
              aria-label="搜索内容"
            />
          </form>

          <ThemeModeToggle class="hidden sm:inline-flex" />

          <span class="text-[#D4D4D8] font-light dark:text-[#3F3F46]" aria-hidden="true">/</span>
          <a href="/login" class="mono-link">登录</a>
        </nav>
      </div>
    </header>

    <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
      <article
        class="min-h-screen"
        style="overflow-anchor: none;"
        itemscope
        itemtype="https://schema.org/BlogPosting"
      >
          <meta itemprop="headline" :content="detailView.header.title" />
          <meta itemprop="datePublished" :content="detailView.header.meta.isoTime" />
          <meta itemprop="dateModified" :content="detailView.header.meta.isoTime" />
          <meta itemprop="articleSection" :content="detailView.header.meta.categoryName" />
          <meta itemprop="description" :content="articleSummary" />
          <meta itemprop="author" :content="authorName" />
          <meta v-if="canonicalUrl" itemprop="mainEntityOfPage" :content="canonicalUrl" />

          <header :class="themeTokens.articleDetail.header">
            <h1 :class="themeTokens.articleDetail.title" itemprop="headline">
              {{ detailView.header.title }}
            </h1>

            <div :class="themeTokens.articleDetail.metaRow">
              <time
                :datetime="detailView.header.meta.isoTime"
                :title="detailView.header.meta.fullTime"
                itemprop="datePublished"
              >
                {{ detailView.header.meta.displayTime }}
              </time>
              <span :class="themeTokens.articleDetail.metaSeparator" aria-hidden="true">/</span>
              <a
                v-if="detailView.header.meta.categoryHref"
                :href="detailView.header.meta.categoryHref"
                :class="themeTokens.articleDetail.categoryLink"
                data-public-link="filter"
                itemprop="articleSection"
              >
                {{ detailView.header.meta.categoryName }}
              </a>
              <span v-else :class="themeTokens.articleDetail.categoryText" itemprop="articleSection">
                {{ detailView.header.meta.categoryName }}
              </span>
              <span :class="themeTokens.articleDetail.metaSeparator" aria-hidden="true">/</span>
              <span>{{ detailView.header.viewsText }}</span>
            </div>
          </header>

          <ArticleReadingNotice
            :visible="detailView.body.notice.visible"
            :label="detailView.body.notice.label"
          />

          <ArticleDetailBody>
            <div
              :class="[markdownSurfaceClasses.root, markdownSurfaceClasses.body]"
              role="article"
              aria-live="polite"
              data-markdown-renderer="wasm"
              itemprop="articleBody"
              v-html="trustedBodyContent"
            ></div>
          </ArticleDetailBody>

          <footer
            v-if="detailView.header.tags.length > 0"
            class="mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-[#F4F4F5] dark:border-[#18181B]"
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
            :data-article-id="String(props.articleId ?? 0)"
            class="mt-16 sm:mt-24 pt-12 border-t border-[#0F0F11]/5 pb-24 min-h-[11rem] sm:min-h-[13rem]"
            aria-label="评论"
          >
            <div
              id="fsus-comments-island-content"
              class="min-h-[7rem] sm:min-h-[8rem]"
            ></div>
          </section>
      </article>
      <component :is="'script'" v-if="articleStructuredData" type="application/ld+json" v-html="articleStructuredData"></component>
    </main>

    <footer v-once class="w-full pb-12 pt-8 sm:pb-16 border-t border-[#F4F4F5] dark:border-[#18181B]">
      <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
        <div class="text-sm text-[#8E8E93] dark:text-[#A1A1AA] font-medium tracking-normal select-none">
          &copy; {{ currentYear }} {{ siteTitleText }}. All rights reserved.
        </div>

        <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-[#8E8E93] dark:text-[#A1A1AA]">
          <a href="/api/Article/rss" class="rounded-[8px] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">RSS</a>
          <a href="#top" class="rounded-[8px] hover:text-[#2A599C] dark:hover:text-[#F4F4F5] transition-colors flex items-center gap-2 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2A599C]">
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
import ArticleReadingNotice from '@/components/article/ArticleReadingNotice.vue'
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue'
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue'
import { themeTokens } from '@/ui-tokens/themeTokens'
import { buildArticleStructuredData } from '@/utils/articleStructuredData'
import { trustRendererHtml } from '@/utils/trustedHtml'
import { emptyArticleDetailPageView } from '@/view-contracts/articleDetail'
import type { PublicArticleDetailHydrationPayload } from './types'

const props = defineProps<PublicArticleDetailHydrationPayload>()
const siteTitleText = props.siteTitle?.trim() || 'Fsus'
const currentYear = new Date().getFullYear()
const detailView = props.detailView ?? emptyArticleDetailPageView
const authorName = props.authorName?.trim() || siteTitleText || 'Fsu'
const canonicalUrl = props.baseUrl && props.articleId
  ? `${props.baseUrl.replace(/\/+$/, '')}/article/${String(props.articleId)}`
  : null
const trustedBodyContent = computed(() => trustRendererHtml(detailView.body.content || ''))
const articleSummary = detailView.body.content ? detailView.body.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220) : detailView.header.title
const articleStructuredData = computed(() => buildArticleStructuredData({
  id: props.articleId,
  title: detailView.header.title,
  summary: articleSummary,
  articleBody: trustedBodyContent.value,
  publishedTime: detailView.header.meta.isoTime,
  authorName,
  categoryName: detailView.header.meta.categoryName,
  canonicalUrl
}))
</script>
