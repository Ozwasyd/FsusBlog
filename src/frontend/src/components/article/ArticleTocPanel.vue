<template>
  <aside
    v-if="items.length > 0"
    class="article-toc-panel hidden xl:block"
    aria-label="文章目录"
  >
    <p class="article-toc-panel__title">目录</p>
    <nav class="article-toc-panel__nav">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="article-toc-panel__item blog-motion-reading-control"
        :class="{
          'article-toc-panel__item--h3': item.level === 3,
          'article-toc-panel__item--active': item.id === activeId
        }"
        :aria-current="item.id === activeId ? 'location' : undefined"
        @click="emit('navigate', item.id)"
      >
        {{ item.text }}
      </button>
    </nav>
  </aside>

  <el-drawer
    v-model="drawerVisible"
    title="目录"
    direction="btt"
    size="62%"
    class="article-toc-drawer"
    data-fsus-motion-surface="mobile-drawer"
  >
    <nav class="article-toc-drawer__nav" aria-label="文章目录">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="article-toc-drawer__item blog-motion-reading-control"
        :class="{
          'article-toc-drawer__item--h3': item.level === 3,
          'article-toc-drawer__item--active': item.id === activeId
        }"
        :aria-current="item.id === activeId ? 'location' : undefined"
        @click="handleDrawerNavigate(item.id)"
      >
        {{ item.text }}
      </button>
    </nav>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ArticleTocItem } from '@/composables/article/useArticleToc'

const props = defineProps<{
  items: ArticleTocItem[]
  activeId: string | null
  mobileOpen: boolean
}>()

const emit = defineEmits<{
  (event: 'navigate', id: string): void
  (event: 'update:mobileOpen', value: boolean): void
}>()

const drawerVisible = computed({
  get: () => props.mobileOpen,
  set: (value: boolean) => emit('update:mobileOpen', value)
})

const handleDrawerNavigate = (id: string): void => {
  emit('navigate', id)
  emit('update:mobileOpen', false)
}
</script>

<style scoped>
.article-toc-panel {
  position: fixed;
  top: 8.5rem;
  right: max(1.5rem, calc((100vw - 72rem) / 2));
  z-index: 20;
  width: 12rem;
  max-height: calc(100vh - 11rem);
  overflow: auto;
  border-left: 1px solid var(--fsusblog-panel-border);
  padding-left: 0.875rem;
}

.article-toc-panel__title {
  margin: 0 0 0.75rem;
  color: var(--fsusblog-text-subtle);
  font-size: 0.6875rem;
  font-weight: 800;
}

.article-toc-panel__nav,
.article-toc-drawer__nav {
  display: grid;
  gap: 0.125rem;
}

.article-toc-panel__item,
.article-toc-drawer__item {
  min-height: 2.25rem;
  border: 0;
  border-left: 1px solid transparent;
  background: transparent;
  color: var(--fsusblog-text-muted);
  padding: 0.35rem 0.25rem 0.35rem 0.625rem;
  text-align: left;
  font-size: 0.75rem;
  line-height: 1.45;
}

.article-toc-panel__item--h3,
.article-toc-drawer__item--h3 {
  padding-left: 1.375rem;
  font-size: 0.71875rem;
}

.article-toc-panel__item:hover,
.article-toc-panel__item:focus-visible,
.article-toc-drawer__item:hover,
.article-toc-drawer__item:focus-visible,
.article-toc-panel__item--active,
.article-toc-drawer__item--active {
  border-left-color: color-mix(in srgb, var(--fsusblog-text-primary) 54%, transparent);
  color: var(--fsusblog-text-primary);
  outline: none;
}

.article-toc-drawer__nav {
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem);
}
</style>
