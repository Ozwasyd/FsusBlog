<template>
  <!-- Hydration invariant: do not use Transition appear until FsusUI exposes a hydration-aware transition API. -->
  <FsuTransition :name="fsusBlogMotionPresets.mobileBar">
    <nav class="article-mobile-action-bar blog-motion-mobile-bar" data-mobile-reading-actions="true" aria-label="文章快捷操作">
    <button
      v-if="hasToc"
      type="button"
      class="article-mobile-action-bar__button blog-motion-reading-control"
      aria-label="打开文章目录"
      @click="emit('toc')"
    >
      目录
    </button>
    <button
      type="button"
      class="article-mobile-action-bar__button blog-motion-reading-control"
      aria-label="跳转到评论区"
      @click="emit('comments')"
    >
      评论
    </button>
    <button
      type="button"
      class="article-mobile-action-bar__button blog-motion-reading-control"
      aria-label="分享或复制文章链接"
      @click="emit('share')"
    >
      分享
    </button>
    <button
      type="button"
      class="article-mobile-action-bar__button blog-motion-reading-control"
      aria-label="回到文章顶部"
      v-motion="{ name: fsusBlogMotionPresets.backToTop, once: true }"
      data-fsus-motion-surface="back-to-top"
      @click="emit('top')"
    >
      顶部
    </button>
    </nav>
  </FsuTransition>
</template>

<script setup lang="ts">
import { FsuTransition, fsusBlogMotionPresets, vMotion } from '@/fsusui/motion'

defineProps<{
  hasToc: boolean
}>()

const emit = defineEmits<{
  (event: 'toc'): void
  (event: 'comments'): void
  (event: 'share'): void
  (event: 'top'): void
}>()
</script>

<style scoped>
.article-mobile-action-bar {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 60;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  min-height: calc(3rem + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
  backdrop-filter: none;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.article-mobile-action-bar__button {
  min-height: 3rem;
  border: 0;
  background: transparent;
  color: var(--fsusblog-text-muted);
  font-size: 0.75rem;
  font-weight: 700;
}

.article-mobile-action-bar__button:hover {
  color: var(--fsusblog-text-primary);
}

.article-mobile-action-bar__button:focus-visible {
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
  color: var(--fsusblog-text-primary);
  outline: none;
}

@media (min-width: 768px) {
  .article-mobile-action-bar {
    display: none;
  }
}

</style>
