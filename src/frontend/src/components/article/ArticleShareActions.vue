<template>
  <div class="article-share-actions">
    <button
      type="button"
      class="article-share-actions__button blog-motion-reading-control"
      aria-label="复制当前文章链接"
      @click="copyLink"
    >
      复制链接
    </button>
  </div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useArticleShare } from '@/composables/article/useArticleShare'

const props = defineProps<{
  title: string
  canonicalUrl: string | null
}>()

const { copyLink } = useArticleShare({
  title: toRef(props, 'title'),
  canonicalUrl: toRef(props, 'canonicalUrl')
})
</script>

<style scoped>
.article-share-actions {
  margin-top: 1.25rem;
}

.article-share-actions__button {
  min-height: 2.75rem;
  border: 1px solid var(--fsusblog-panel-border);
  background: transparent;
  color: var(--fsusblog-text-muted);
  padding: 0 0.875rem;
  font-size: 0.75rem;
  line-height: 1;
}

.article-share-actions__button:hover,
.article-share-actions__button:focus-visible {
  border-color: color-mix(in srgb, var(--fsusblog-text-primary) 44%, transparent);
  background: var(--fsusblog-panel-bg);
  color: var(--fsusblog-text-primary);
  outline: none;
}
</style>
