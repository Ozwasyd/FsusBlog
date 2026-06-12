<template>
  <article
    class="public-article-detail max-w-4xl mx-auto px-6 sm:px-12 min-h-screen pt-16 sm:pt-24 pb-32"
    itemscope
    itemtype="https://schema.org/BlogPosting"
  >
    <meta itemprop="headline" :content="detailView.header.title" />
    <meta itemprop="datePublished" :content="detailView.header.meta.isoTime" />
    <meta itemprop="dateModified" :content="detailView.header.meta.isoTime" />
    <meta itemprop="articleSection" :content="detailView.header.meta.categoryName" />
    <meta itemprop="description" :content="articleSummary || detailView.header.title" />
    <meta itemprop="author" :content="authorName || 'Fsu'" />
    <meta
      v-if="canonicalUrl"
      itemprop="mainEntityOfPage"
      :content="canonicalUrl"
    />

    <div
      v-if="detailView.header.coverImageUrl"
      v-scroll-reveal="fsusBlogScrollRevealMotion"
      class="mb-16 blog-motion-state-change"
      data-fsus-motion-surface="article-cover"
    >
      <img
        :src="detailView.header.coverImageUrl"
        :alt="`${detailView.header.title} — 题图`"
        class="blog-motion-media-hover aspect-video w-full rounded-[var(--fsus-radius-panel)] object-cover shadow-none"
        width="1200"
        height="675"
        sizes="(min-width: 1024px) 56rem, calc(100vw - 3rem)"
        loading="eager"
        decoding="async"
        fetchpriority="high"
      />
    </div>

    <header
      v-motion="{ name: fsusBlogMotionPresets.articleTitle, once: true }"
      :class="themeTokens.articleDetail.header"
      data-fsus-motion-surface="article-title"
    >
      <ArticleDetailHeader :view="detailView.header" :link-mode="linkMode" />
      <slot name="header-actions" />
    </header>

    <section itemprop="articleBody" class="mt-20 sm:mt-24">
      <ArticleDetailBody>
        <ArticleReadingNotice
          :notice="detailView.body.notice"
        />
        <div
          v-if="!hasBodyContent"
          class="border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-10 py-16 text-center"
          aria-label="文章正文为空"
        >
          <p class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-subtle)]">
            这篇文章目前还没有正文内容
          </p>
        </div>
        <slot v-else name="body">
          <MarkdownRenderer
            itemprop="articleBody"
            :content="bodyContent"
            :initial-html="bodyHtml"
            mode="article"
          />
        </slot>
      </ArticleDetailBody>
    </section>

    <footer
      v-if="detailView.header.tags.length > 0"
      class="mt-24 sm:mt-32 pt-12 sm:pt-16 border-t border-[var(--fsusblog-panel-border)]"
    >
      <ArticleDetailTagsFooter :view="detailView.header" :link-mode="linkMode" />
    </footer>

    <section
      v-if="hasRelatedReading"
      id="fsus-related-reading"
      data-public-related-reading="true"
      class="mt-24 sm:mt-32 border-t border-[var(--fsusblog-panel-border)] pt-12 sm:pt-16"
      aria-labelledby="fsus-related-reading-heading"
    >
      <div class="flex flex-col gap-8">
        <div class="flex items-center justify-between gap-6">
          <h2
            id="fsus-related-reading-heading"
            class="text-sm font-black normal-case tracking-normal text-[var(--fsusblog-text-primary)]"
          >
            {{ detailView.relatedReading.title }}
          </h2>
        </div>

        <nav
          v-if="detailView.relatedReading.previous || detailView.relatedReading.next"
          class="grid gap-4 sm:grid-cols-2"
          aria-label="上一篇和下一篇"
        >
          <a
            v-if="detailView.relatedReading.previous"
            :href="detailView.relatedReading.previous.href"
            class="group blog-motion-state-change border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-5 py-4 hover:border-[var(--fsusblog-text-primary)]/40"
            data-related-role="previous"
          >
            <span class="block text-[10px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
              {{ detailView.relatedReading.previousLabel }}
            </span>
            <span class="mt-2 block text-sm font-bold leading-6 text-[var(--fsusblog-text-primary)] group-hover:underline">
              {{ detailView.relatedReading.previous.title }}
            </span>
            <span class="mt-2 block text-[11px] normal-case tracking-normal text-[var(--fsusblog-text-subtle)]">
              {{ detailView.relatedReading.previous.reason }} · {{ detailView.relatedReading.previous.displayTime }}
            </span>
          </a>
          <span v-else class="hidden sm:block"></span>

          <a
            v-if="detailView.relatedReading.next"
            :href="detailView.relatedReading.next.href"
            class="group blog-motion-state-change border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)] px-5 py-4 hover:border-[var(--fsusblog-text-primary)]/40 sm:text-right"
            data-related-role="next"
          >
            <span class="block text-[10px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
              {{ detailView.relatedReading.nextLabel }}
            </span>
            <span class="mt-2 block text-sm font-bold leading-6 text-[var(--fsusblog-text-primary)] group-hover:underline">
              {{ detailView.relatedReading.next.title }}
            </span>
            <span class="mt-2 block text-[11px] normal-case tracking-normal text-[var(--fsusblog-text-subtle)]">
              {{ detailView.relatedReading.next.reason }} · {{ detailView.relatedReading.next.displayTime }}
            </span>
          </a>
        </nav>

        <div v-if="detailView.relatedReading.items.length > 0">
          <h3 class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
            {{ detailView.relatedReading.relatedLabel }}
          </h3>
          <ol class="mt-4 grid gap-4">
            <li
              v-for="item in detailView.relatedReading.items"
              :key="item.id"
              class="border-b border-[var(--fsusblog-panel-border)] pb-4 last:border-b-0 last:pb-0"
            >
              <a
                :href="item.href"
                class="group block"
                data-related-role="related"
              >
                <span class="block text-sm font-bold leading-6 text-[var(--fsusblog-text-primary)] group-hover:underline">
                  {{ item.title }}
                </span>
                <span class="mt-1 block text-[11px] normal-case tracking-normal text-[var(--fsusblog-text-subtle)]">
                  {{ item.reason }} · {{ item.displayTime }}
                </span>
                <span
                  v-if="item.summary"
                  class="mt-2 block text-xs leading-6 text-[var(--fsusblog-text-muted)]"
                >
                  {{ item.summary }}
                </span>
              </a>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <section
      id="fsus-comments-island"
      class="mt-32 border-t border-[var(--fsusblog-panel-border)] pt-16"
      :data-article-id="String(safeArticleId)"
    >
      <span id="comments" class="sr-only">评论</span>
      <div
        id="fsus-comments-island-content"
        class="min-h-[10rem]"
      >
        <slot name="comments">
          <ArticleDetailCommentsPlaceholder
            :title="detailView.comments.placeholderTitle"
            :body="detailView.comments.placeholderBody"
            :hint="detailView.comments.placeholderHint"
          />
        </slot>
      </div>
    </section>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ArticleReadingNotice from '@/components/article/ArticleReadingNotice.vue'
import ArticleDetailHeader from '@/components/article/ArticleDetailHeader.vue'
import ArticleDetailTagsFooter from '@/components/article/ArticleDetailTagsFooter.vue'
import ArticleDetailBody from '@/components/public/ArticleDetailBody.vue'
import ArticleDetailCommentsPlaceholder from '@/components/public/ArticleDetailCommentsPlaceholder.vue'
import MarkdownRenderer from '@/components/ui/MarkdownRenderer.vue'
import {
  fsusBlogMotionPresets,
  fsusBlogScrollRevealMotion,
  vMotion,
  vScrollReveal
} from '@/fsusui/motion'
import { themeTokens } from '@/ui-tokens/themeTokens'
import type { ArticleDetailPageViewContract } from '@/view-contracts/articleDetail'

const props = withDefaults(defineProps<{
  detailView: ArticleDetailPageViewContract
  articleId: number | string | null | undefined
  authorName: string
  articleSummary: string
  canonicalUrl?: string | null
  hasBodyContent: boolean
  bodyContent?: string
  bodyHtml?: string
  linkMode?: 'anchor' | 'router'
}>(), {
  canonicalUrl: null,
  bodyContent: '',
  bodyHtml: '',
  linkMode: 'anchor'
})

const safeArticleId = computed(() => {
  const normalized = Number(props.articleId)
  return Number.isFinite(normalized) && normalized > 0 ? Math.trunc(normalized) : 0
})

const hasRelatedReading = computed(() => (
  props.detailView.relatedReading.previous !== null
  || props.detailView.relatedReading.next !== null
  || props.detailView.relatedReading.items.length > 0
))
</script>

<style scoped>
.public-article-detail {
  overflow-anchor: none;
}
</style>
