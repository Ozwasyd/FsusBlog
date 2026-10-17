<template>
    <nav
        class="article-write-inspector-rail"
        :class="`article-write-inspector-rail--${placement}`"
        aria-label="文章检查器"
    >
        <FsusUiButton
            v-for="view in inspectorViews"
            :key="view.id"
            :ref="(element: Element | ComponentPublicInstance | null) => registerTrigger(view.id, element)"
            native-type="button"
            size="large"
            text
            :type="activeInspector === view.id ? 'primary' : 'default'"
            :bg="activeInspector === view.id"
            class="article-write-inspector-rail__trigger"
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
        </FsusUiButton>
    </nav>
</template>

<script setup lang="ts">
import { type Component, type ComponentPublicInstance } from 'vue';

import {
    articleWriteInspectorRegistry,
    type ArticleWriteInspectorView
} from '@/composables/useArticleWriteInspector';
import { FsusUiButton } from '@/fsusui/button';
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

const registerTrigger = (
    view: ArticleWriteInspectorView,
    element: Element | ComponentPublicInstance | null
): void =>
{
    const buttonElement: unknown = element && !(element instanceof Element) && 'ref' in element
        ? element.ref
        : null;
    // Template refs are registered through the prop without creating a second rail state owner.
    props.registerTriggerElement?.(view, buttonElement instanceof HTMLButtonElement ? buttonElement : null);
};

const activate = (view: ArticleWriteInspectorView, event: MouseEvent): void =>
{
    emit('activate', view, event.currentTarget as HTMLElement);
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
    width: var(--fsus-control-height-spacious);
    flex: 0 0 auto;
    margin: 0;
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
