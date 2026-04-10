<template>
  <div class="max-w-3xl mx-auto px-6 sm:px-8 min-h-screen">
    <article style="overflow-anchor: none;">
      <header :class="themeTokens.articleDetail.header">
        <slot name="header" />
      </header>

      <slot name="body" />

      <footer
        v-if="view.tags.length > 0"
        class="mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-zinc-100"
      >
        <slot name="footer" />
      </footer>

      <section
        id="fsus-comments-island"
        :class="themeTokens.articleDetail.commentsRoot"
        :data-article-id="String(articleId)"
      >
        <h3 :class="themeTokens.articleDetail.commentsHeading">
          {{ commentsHeading }}
        </h3>
        <slot name="comments">
          <div :class="themeTokens.articleDetail.commentsPlaceholderRoot">
            <p :class="themeTokens.articleDetail.commentsPlaceholderTitle">
              {{ commentsPlaceholderTitle }}
            </p>
            <p :class="themeTokens.articleDetail.commentsPlaceholderBody">
              {{ commentsPlaceholderBody }}
            </p>
            <p :class="themeTokens.articleDetail.commentsPlaceholderHint">
              {{ commentsPlaceholderHint }}
            </p>
          </div>
        </slot>
      </section>
    </article>
  </div>
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
}>();
</script>
