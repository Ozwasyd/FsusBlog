<template>
  <nav class="article-mobile-action-bar" aria-label="文章快捷操作">
    <button
      v-if="hasToc"
      type="button"
      class="article-mobile-action-bar__button"
      aria-label="打开文章目录"
      @click="emit('toc')"
    >
      目录
    </button>
    <button
      type="button"
      class="article-mobile-action-bar__button"
      aria-label="跳转到评论区"
      @click="emit('comments')"
    >
      评论
    </button>
    <button
      type="button"
      class="article-mobile-action-bar__button"
      aria-label="分享或复制文章链接"
      @click="emit('share')"
    >
      分享
    </button>
    <button
      type="button"
      class="article-mobile-action-bar__button"
      aria-label="回到文章顶部"
      @click="emit('top')"
    >
      顶部
    </button>
  </nav>
</template>

<script setup lang="ts">
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
  background: color-mix(in srgb, var(--fsusblog-page-bg) 88%, transparent);
  backdrop-filter: blur(var(--fsus-backdrop-blur-soft));
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

.article-mobile-action-bar__button:hover,
.article-mobile-action-bar__button:focus-visible {
  color: var(--fsusblog-text-primary);
  outline: 1px solid color-mix(in srgb, var(--fsusblog-text-primary) 32%, transparent);
  outline-offset: -3px;
}

@media (min-width: 768px) {
  .article-mobile-action-bar {
    display: none;
  }
}
</style>
