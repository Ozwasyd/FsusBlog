<template>
  <article
    class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen"
    style="overflow-anchor: none;"
    itemscope
    itemtype="https://schema.org/BlogPosting"
  >
      <meta itemprop="headline" :content="view.title" />
      <meta itemprop="datePublished" :content="view.meta.isoTime" />
      <meta itemprop="dateModified" :content="view.meta.isoTime" />
      <meta itemprop="articleSection" :content="view.meta.categoryName" />
      <meta itemprop="description" :content="description || view.title" />
      <meta itemprop="author" :content="authorName || 'Fsu'" />
      <meta
        v-if="canonicalUrl"
        itemprop="mainEntityOfPage"
        :content="canonicalUrl"
      />

      <header :class="themeTokens.articleDetail.header">
        <slot name="header" />
      </header>

      <section itemprop="articleBody">
        <slot name="body" />
      </section>

      <footer
        v-if="view.tags.length > 0"
        class="mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-[#F4F4F5] dark:border-[#18181B]"
      >
        <slot name="footer" />
      </footer>

      <section
        id="fsus-comments-island"
        :class="themeTokens.articleDetail.commentsRoot"
        :data-article-id="String(articleId)"
      >
        <slot name="comments">
          <div :class="themeTokens.articleDetail.commentsPlaceholderRoot" aria-hidden="true" />
        </slot>
      </section>
  </article>
</template>

<script setup lang="ts">
import { themeTokens } from '@/ui-tokens/themeTokens';
import type { ArticleDetailHeaderViewContract } from '@/view-contracts/articleDetail';

defineProps<{
  view: ArticleDetailHeaderViewContract;
  articleId: number | string;
  commentsHeading: string;
  commentsPlaceholderTitle: string;
  commentsPlaceholderBody: string;
  commentsPlaceholderHint: string;
  authorName?: string;
  description?: string;
  canonicalUrl?: string;
}>();
</script>
