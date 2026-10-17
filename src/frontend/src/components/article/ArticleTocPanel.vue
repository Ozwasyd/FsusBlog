<template>
    <aside
        v-if="items.length > 0"
        class="article-toc-panel hidden xl:block"
        data-fsus-surface="reading"
        :aria-label="messages.article.actions.tocAria"
    >
        <p class="article-toc-panel__title">{{ messages.article.actions.toc }}</p>
        <nav class="article-toc-panel__nav">
            <FsusUiButton
                v-for="item in items"
                :key="item.id"
                native-type="button"
                text
                size="small"
                class="article-toc-panel__item"
                :class="{
                    'article-toc-panel__item--h3': item.level === 3,
                    'article-toc-panel__item--active': item.id === activeId
                }"
                :aria-current="item.id === activeId ? 'location' : undefined"
                @click="emit('navigate', item.id)"
            >
                {{ item.text }}
            </FsusUiButton>
        </nav>
    </aside>

    <ElDrawer
        v-model="drawerVisible"
        :title="messages.article.actions.toc"
        direction="btt"
        size="62%"
        class="article-toc-drawer"
        data-fsus-surface="reading"
        :motion="fsusBlogMotionPresets.mobileDrawer"
    >
        <nav
            class="article-toc-drawer__nav"
            :aria-label="messages.article.actions.tocAria"
        >
            <FsusUiButton
                v-for="item in items"
                :key="item.id"
                native-type="button"
                text
                size="small"
                class="article-toc-drawer__item"
                :class="{
                    'article-toc-drawer__item--h3': item.level === 3,
                    'article-toc-drawer__item--active': item.id === activeId
                }"
                :aria-current="item.id === activeId ? 'location' : undefined"
                @click="handleDrawerNavigate(item.id)"
            >
                {{ item.text }}
            </FsusUiButton>
        </nav>
    </ElDrawer>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { ArticleTocItem } from '@/composables/article/useArticleToc';
import { useI18nText } from '@/composables/useI18nText';
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion';
import { FsusUiButton } from '@/fsusui/button';

const props = defineProps<{
    items: ArticleTocItem[];
    activeId: string | null;
    mobileOpen: boolean;
}>();

const { messages } = useI18nText();

const emit = defineEmits<{
    (event: 'navigate', id: string): void;
    (event: 'update:mobileOpen', value: boolean): void;
}>();

const drawerVisible = computed({
    get: () => props.mobileOpen,
    set: (value: boolean) =>
    {
        if (value !== props.mobileOpen)
        {
            emit('update:mobileOpen', value);
        }
    }
});

const handleDrawerNavigate = (id: string): void =>
{
    emit('navigate', id);
    emit('update:mobileOpen', false);
};
</script>

<style scoped>
.article-toc-panel
 {
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

.article-toc-panel__title
 {
    margin: 0 0 0.75rem;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 700;
}

.article-toc-panel__nav,
.article-toc-drawer__nav
 {
    display: grid;
    gap: 0.125rem;
}

.article-toc-panel__item,
.article-toc-drawer__item
 {
    position: relative;
    min-height: 2.5rem;
    height: auto;
    min-width: 0;
    justify-content: flex-start;
    padding-left: calc(0.625rem + 2px);
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
}

.article-toc-panel__item + .article-toc-panel__item,
.article-toc-drawer__item + .article-toc-drawer__item
 {
    margin-left: 0;
}

.article-toc-panel__item--h3,
.article-toc-drawer__item--h3
 {
    padding-left: calc(1.375rem + 2px);
}

.article-toc-panel__item--active,
.article-toc-drawer__item--active
 {
    color: var(--fsusblog-text-primary);
}

.article-toc-panel__item--active::after,
.article-toc-drawer__item--active::after
 {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 2px;
    background: var(--fsusblog-color-primary);
    pointer-events: none;
    content: '';
}

.article-toc-drawer__nav
 {
    padding-bottom: calc(var(--fsus-safe-area-inset-bottom) + 1rem);
}
</style>
