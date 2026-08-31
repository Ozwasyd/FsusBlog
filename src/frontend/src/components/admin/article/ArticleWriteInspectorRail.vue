<template>
    <nav
        class="article-write-inspector-rail"
        :class="`article-write-inspector-rail--${placement}`"
        aria-label="文章检查器"
    >
        <button
            v-for="view in inspectorViews"
            :key="view.id"
            :ref="(element) => registerTrigger(view.id, element)"
            type="button"
            class="article-write-inspector-rail__trigger"
            :class="{ 'is-active': activeInspector === view.id }"
            :aria-label="view.label"
            :aria-pressed="activeInspector === view.id"
            :aria-expanded="activeInspector === view.id"
            :aria-controls="`article-write-inspector-view-${view.id}`"
            @click="activate(view.id, $event)"
        >
            <ElIcon aria-hidden="true">
                <component :is="view.icon" />
            </ElIcon>
            <span class="article-write-inspector-rail__label">{{ view.label }}</span>
        </button>
    </nav>
</template>

<script setup lang="ts">
import { type Component, type ComponentPublicInstance } from 'vue';

import {
    articleWriteInspectorRegistry,
    type ArticleWriteInspectorView
} from '@/composables/useArticleWriteInspector';
import { Checked, DocumentChecked, Files, Lock, Picture, View } from '@/fsusui/icons';

const props = defineProps<{
    activeInspector: ArticleWriteInspectorView | null;
    placement: 'desktop' | 'drawer';
    registerTriggerElement?: (view: ArticleWriteInspectorView, element: HTMLElement | null) => void;
}>();

const emit = defineEmits<(event: 'activate', view: ArticleWriteInspectorView, trigger: HTMLElement) => void>();

const inspectorIcons = {
    publish: DocumentChecked,
    rights: Lock,
    check: Checked,
    preview: View,
    versions: Files,
    resources: Picture
} satisfies Record<ArticleWriteInspectorView, Component>;
const inspectorViews = articleWriteInspectorRegistry.map((view) => ({
    ...view,
    icon: inspectorIcons[view.id]
}));

const resolveElement = (
    element: Element | ComponentPublicInstance | null
): HTMLElement | null =>
{
    if (element instanceof HTMLElement)
    {
        return element;
    }
    const componentElement = element?.$el;
    return componentElement instanceof HTMLElement ? componentElement : null;
};

const registerTrigger = (
    view: ArticleWriteInspectorView,
    element: Element | ComponentPublicInstance | null
): void =>
{
    const resolved = resolveElement(element);
    // Template refs are registered through the prop without creating a second rail state owner.
    props.registerTriggerElement?.(view, resolved);
};

const activate = (view: ArticleWriteInspectorView, event: MouseEvent): void =>
{
    emit('activate', view, event.currentTarget);
};
</script>

<style scoped>
.article-write-inspector-rail
 {
    display: flex;
    gap: var(--fsus-space-1);
    border: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg);
    padding: var(--fsus-space-1);
}

.article-write-inspector-rail--desktop
 {
    position: fixed;
    z-index: var(--fsusblog-z-sticky, 30);
    top: calc(var(--fsus-space-8) * 2);
    right: var(--fsus-space-4);
    flex-direction: column;
    border-radius: var(--fsus-radius-panel);
}

.article-write-inspector-rail--drawer
 {
    position: sticky;
    z-index: 1;
    top: 0;
    overflow-x: auto;
    border-width: 0 0 1px;
    overscroll-behavior-inline: contain;
    scrollbar-width: thin;
}

.article-write-inspector-rail__trigger
 {
    display: inline-grid;
    width: var(--fsus-control-height-spacious);
    height: var(--fsus-control-height-spacious);
    cursor: pointer;
    flex: 0 0 auto;
    place-items: center;
    border: 0;
    border-radius: var(--fsus-radius-control);
    background: transparent;
    color: var(--fsusblog-text-muted);
}

.article-write-inspector-rail__trigger:hover,
.article-write-inspector-rail__trigger.is-active
 {
    background: var(--el-fill-color-light);
    color: var(--fsus-scholarly-blue);
}

.article-write-inspector-rail__trigger:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.article-write-inspector-rail__label
 {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
}
</style>
