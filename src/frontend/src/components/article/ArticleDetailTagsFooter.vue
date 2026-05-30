<template>
  <div :class="themeTokens.articleDetail.tagList">
    <component
      :is="tagComponent"
      v-for="tag in view.tags"
      :key="tag.label"
      v-bind="tagLinkProps(tag)"
      :class="themeTokens.articleDetail.tagLink"
      data-public-link="filter"
    >
      {{ tag.label }}
    </component>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { themeTokens } from '@/ui-tokens/themeTokens'
import type { ArticleDetailHeaderViewContract } from '@/view-contracts/articleDetail'

const props = withDefaults(defineProps<{
  view: ArticleDetailHeaderViewContract;
  linkMode?: 'router' | 'anchor';
}>(), {
  linkMode: 'router'
})

const tagComponent = computed(() => (
  props.linkMode === 'anchor'
    ? 'a'
    : 'RouterLink'
))

const tagHref = (tag: ArticleDetailHeaderViewContract['tags'][number]): string => (
  tag.href?.trim()
  || `/tag/${encodeURIComponent(tag.label.replace(/^#/, ''))}`
)

const tagLinkProps = (tag: ArticleDetailHeaderViewContract['tags'][number]): Record<string, string> => (
  props.linkMode === 'anchor'
    ? { href: tagHref(tag) }
    : { to: tagHref(tag) }
)
</script>
