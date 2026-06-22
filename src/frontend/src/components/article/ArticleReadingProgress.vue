<template>
  <div class="article-reading-progress" data-fsus-surface="reading" data-reading-progress="true" aria-hidden="true">
    <div
      class="article-reading-progress__bar"
      :style="{ '--article-reading-progress': progress }"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useArticleReadingProgress } from '@/composables/article/useArticleReadingProgress'

const props = defineProps<{
  contentRoot: HTMLElement | null
}>()

const { progress: rawProgress } = useArticleReadingProgress(() => props.contentRoot)
const progress = computed(() => rawProgress.value.toFixed(4))
</script>

<style scoped>
.article-reading-progress {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 50;
  width: 100%;
  height: 2px;
  background: color-mix(in srgb, var(--fsusblog-panel-border) 72%, transparent);
  pointer-events: none;
}

.article-reading-progress__bar {
  width: 100%;
  height: 100%;
  transform: scaleX(var(--article-reading-progress, 0));
  transform-origin: left center;
  background: color-mix(in srgb, var(--fsusblog-text-primary) 62%, transparent);
  transition: transform var(--blog-motion-fast) var(--blog-motion-ease);
}

@media (prefers-reduced-motion: reduce) {
  .article-reading-progress__bar {
    transition-duration: 1ms;
  }
}
</style>
