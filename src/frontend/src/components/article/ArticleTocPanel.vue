<template>
  <aside
    v-if="items.length > 0"
    class="article-toc-panel hidden xl:block"
    data-fsus-surface="reading"
    :aria-label="messages.article.actions.tocAria"
  >
    <p class="article-toc-panel__title">{{ messages.article.actions.toc }}</p>
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
    :title="messages.article.actions.toc"
    direction="btt"
    size="62%"
    class="article-toc-drawer"
    data-fsus-surface="reading"
    :motion="fsusBlogMotionPresets.mobileDrawer"
  >
    <nav class="article-toc-drawer__nav" :aria-label="messages.article.actions.tocAria">
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
import { useI18nText } from '@/composables/useI18nText'
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion'

const props = defineProps<{
  items: ArticleTocItem[]
  activeId: string | null
  mobileOpen: boolean
}>()

const { messages } = useI18nText()

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
  max-height: calc(var(--fsus-viewport-block-size) - 11rem);
  overflow: auto;
  border-left: 1px solid var(--fsusblog-panel-border);
  padding-left: 0.875rem;
}

.article-toc-panel__title {
  margin: 0 0 0.75rem;
  color: var(--fsusblog-text-muted);
  font-size: 12px;
  font-weight: 700;
}

.article-toc-panel__nav,
.article-toc-drawer__nav {
  display: grid;
  gap: 0.125rem;
}

.article-toc-panel__item,
.article-toc-drawer__item {
  min-height: 2.5rem;
  border: 0;
  border-left: 2px solid transparent;
  border-radius: var(--fsusblog-radius-control);
  background: transparent;
  color: var(--fsusblog-text-muted);
  padding: 0.35rem 0.25rem 0.35rem 0.625rem;
  text-align: left;
  font-size: 12px;
  line-height: 1.45;
}

.article-toc-panel__item--h3,
.article-toc-drawer__item--h3 {
  padding-left: 1.375rem;
  font-size: 12px;
}

.article-toc-panel__item:hover,
.article-toc-drawer__item:hover,
.article-toc-panel__item--active,
.article-toc-drawer__item--active {
  border-left-color: var(--fsusblog-color-primary);
  color: var(--fsusblog-text-primary);
}

.article-toc-panel__item:focus-visible,
.article-toc-drawer__item:focus-visible {
  border-left-color: var(--fsusblog-color-primary);
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
  color: var(--fsusblog-text-primary);
  outline: none;
}

.article-toc-drawer__nav {
  padding-bottom: calc(var(--fsus-safe-area-inset-bottom) + 1rem);
}
</style>
