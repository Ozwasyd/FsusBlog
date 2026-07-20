<template>
  <div data-fsus-surface="reading">
    <h1 :class="themeTokens.articleDetail.title" itemprop="headline">
      {{ view.title }}
    </h1>

    <div :class="themeTokens.articleDetail.metaRow">
      <span>{{ messages.article.metadata.publishedAt }}</span>
      <time :datetime="view.meta.published.isoTime" :title="formatDate(view.meta.published.isoTime, fullDateOptions)" itemprop="datePublished">
        {{ formatDate(view.meta.published.isoTime) }}
      </time>
      <template v-if="view.meta.modified">
        <span :class="themeTokens.articleDetail.metaSeparator" aria-hidden="true">·</span>
        <span>{{ messages.article.metadata.updatedAt }}</span>
        <time :datetime="view.meta.modified.isoTime" :title="formatDate(view.meta.modified.isoTime, fullDateOptions)" itemprop="dateModified">
          {{ formatDate(view.meta.modified.isoTime) }}
        </time>
      </template>
      <span :class="themeTokens.articleDetail.metaSeparator" aria-hidden="true">·</span>

      <component
        :is="categoryComponent"
        v-if="view.meta.categoryHref"
        v-bind="categoryLinkProps"
        :class="themeTokens.articleDetail.categoryLink"
        data-public-link="filter"
        itemprop="articleSection"
      >
        {{ view.meta.categoryName }}
      </component>
      <span v-else :class="themeTokens.articleDetail.categoryText" itemprop="articleSection">
        {{ view.meta.categoryName }}
      </span>

      <span :class="themeTokens.articleDetail.metaSeparator" aria-hidden="true">·</span>
      <span data-visual-dynamic>{{ view.viewsText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18nText } from '@/composables/useI18nText'
import { themeTokens } from '@/ui-tokens/themeTokens'
import type { ArticleDetailHeaderViewContract } from '@/view-contracts/articleDetail'

const props = withDefaults(defineProps<{
  view: ArticleDetailHeaderViewContract;
  linkMode?: 'router' | 'anchor';
}>(), {
  linkMode: 'router'
})

const { formatDate, messages } = useI18nText()
const fullDateOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
}

const categoryComponent = computed(() => (
  props.linkMode === 'anchor'
    ? 'a'
    : 'RouterLink'
))

const categoryLinkProps = computed(() => {
  if (!props.view.meta.categoryHref) {
    return {}
  }

  return props.linkMode === 'anchor'
    ? { href: props.view.meta.categoryHref }
    : { to: props.view.meta.categoryHref }
})
</script>
