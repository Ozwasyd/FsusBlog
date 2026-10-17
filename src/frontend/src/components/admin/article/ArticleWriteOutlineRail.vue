<template>
    <button
        v-if="isCompact || !isOpen"
        ref="launcherRef"
        type="button"
        class="article-write-outline-launcher"
        aria-label="打开文章大纲"
        aria-controls="article-write-outline-panel"
        :aria-expanded="isOpen"
        data-article-outline-launcher="true"
        @click="openRail"
    >
        <ElIcon aria-hidden="true">
            <List />
        </ElIcon>
        <span class="article-write-outline-visually-hidden">打开文章大纲</span>
    </button>

    <component
        v-if="isCompact || isOpen"
        :is="outlineHost"
        v-bind="outlineHostProperties"
        @close="requestClose"
        @update:model-value="handleHostVisibility"
    >
        <aside
            v-if="!isCompact"
            id="article-write-outline-panel"
            class="article-write-outline-panel"
            role="complementary"
            aria-label="文章大纲"
            data-article-outline-panel="true"
        >
            <OutlinePanelContent
                :snapshot="snapshot"
                :active-heading-id="activeHeadingId"
                :expanded-node-ids="expandedNodeIds"
                @toggle-node="toggleNode"
                @reveal-heading="revealHeading"
                @reveal-range="revealRange"
                @close="requestClose"
            />
        </aside>

        <div
            v-else
            id="article-write-outline-panel"
            class="article-write-outline-drawer-content"
            role="region"
            aria-label="文章大纲"
            data-article-outline-panel="true"
        >
            <OutlinePanelContent
                :snapshot="snapshot"
                :active-heading-id="activeHeadingId"
                :expanded-node-ids="expandedNodeIds"
                @toggle-node="toggleNode"
                @reveal-heading="revealHeading"
                @reveal-range="revealRange"
                @close="requestClose"
            />
        </div>
    </component>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    resolveComponent,
    watch
} from 'vue';

import type { MarkdownEditorOutlineItem, MarkdownOutlineTreeNode } from '@ozwasyd/element-plus';

import type {
    ArticleOutlineSnapshot
} from '@/composables/useArticleOutline';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { List } from '@/fsusui/icons';

import OutlinePanelContent from './ArticleWriteOutlinePanelContent.vue';

defineOptions({ name: 'ArticleWriteOutlineRail' });

const RAIL_OPEN_STORAGE_KEY = 'fsusblog.article-outline.rail-open.v1';

const props = withDefaults(defineProps<{
    snapshot: ArticleOutlineSnapshot | null;
    activeHeadingId?: string | null;
}>(), {
    activeHeadingId: null
});

const emit = defineEmits<{
    (event: 'reveal-heading', item: MarkdownEditorOutlineItem): void;
    (event: 'reveal-range', item: MarkdownEditorOutlineItem): void;
}>();

const isCompact = useMediaQuery('(max-width: 1023px)', false);
const publicDrawer = resolveComponent('ElDrawer');
const isOpen = ref(false);
const launcherRef = ref<HTMLButtonElement | null>(null);
const expandedNodeIds = ref<ReadonlySet<string>>(new Set());
let pendingFocusIntent: number | null = null;
let focusGeneration = 0;
let disposed = false;
let mounted = false;

const outlineHost = computed(() => isCompact.value ? publicDrawer : 'aside');
const outlineHostProperties = computed(() => isCompact.value
    ? {
        modelValue: isOpen.value,
        title: '文章大纲',
        direction: 'ltr',
        size: 'min(86%, 22rem)',
        modal: true,
        lockScroll: true,
        closeOnClickModal: true,
        destroyOnClose: false,
        class: 'article-write-outline-drawer'
    }
    : {
        id: 'article-write-outline-panel-host',
        hidden: !isOpen.value,
        role: 'complementary',
        'aria-label': '文章大纲',
        class: 'article-write-outline-panel-host'
    });

const collectExpandableNodeIds = (tree: readonly MarkdownOutlineTreeNode[]): ReadonlySet<string> =>
{
    const ids = new Set<string>();
    const visit = (nodes: readonly MarkdownOutlineTreeNode[]): void =>
    {
        nodes.forEach((node) =>
        {
            if (node.children.length > 0)
            {
                ids.add(node.nodeId);
                visit(node.children);
            }
        });
    };
    visit(tree);
    return ids;
};

let expandedSnapshotKey = '';
watch(() => [
    props.snapshot?.articleIdentity,
    props.snapshot?.documentIdentity.id,
    props.snapshot?.documentIdentity.epoch
], () =>
{
    const snapshot = props.snapshot;
    const nextKey = snapshot
        ? `${snapshot.articleIdentity}\u0000${snapshot.documentIdentity.id}\u0000${snapshot.documentIdentity.epoch}`
        : '';
    const available = snapshot ? collectExpandableNodeIds(snapshot.tree) : new Set<string>();
    if (nextKey !== expandedSnapshotKey)
    {
        expandedNodeIds.value = available;
        expandedSnapshotKey = nextKey;
        return;
    }
    expandedNodeIds.value = new Set(
        [...expandedNodeIds.value].filter((nodeId) => available.has(nodeId))
    );
}, { immediate: true });

const writeRailPreference = (value: boolean): void =>
{
    if (typeof window === 'undefined')
    {
        return;
    }
    try
    {
        window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, String(value));
    }
    catch
    {
        // Private browsing and blocked storage do not affect the editor.
    }
};

const readRailPreference = (): boolean =>
{
    if (typeof window === 'undefined')
    {
        return false;
    }
    try
    {
        const value = window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY);
        return value === 'true';
    }
    catch
    {
        return false;
    }
};

watch(isOpen, (value) =>
{
    if (mounted)
    {
        writeRailPreference(value);
    }
});

onMounted(() =>
{
    mounted = true;
    isOpen.value = readRailPreference();
});

const invalidateFocusReturn = (): void =>
{
    focusGeneration += 1;
    pendingFocusIntent = null;
};

const focusLauncher = async (): Promise<void> =>
{
    const generation = pendingFocusIntent;
    if (generation === null)
    {
        return;
    }
    pendingFocusIntent = null;
    await nextTick();
    // The modal Drawer owns compact focus restoration. Its native opener remains
    // connected and focusable while open; only the non-modal desktop rail retargets.
    if (!disposed && generation === focusGeneration && !isOpen.value && !isCompact.value)
    {
        launcherRef.value?.focus({ preventScroll: true });
    }
};

const openRail = (): void =>
{
    invalidateFocusReturn();
    isOpen.value = true;
};

const requestClose = async (): Promise<void> =>
{
    if (!isOpen.value)
    {
        return;
    }
    invalidateFocusReturn();
    isOpen.value = false;
    if (!isCompact.value)
    {
        pendingFocusIntent = focusGeneration;
        await focusLauncher();
    }
};

const handleHostVisibility = async (visible: boolean): Promise<void> =>
{
    if (visible)
    {
        openRail();
        return;
    }
    await requestClose();
};

watch(isCompact, invalidateFocusReturn, { flush: 'sync' });
watch(() => props.snapshot, invalidateFocusReturn, { flush: 'sync' });
onBeforeUnmount(() =>
{
    disposed = true;
    mounted = false;
    invalidateFocusReturn();
});

const toggleNode = (nodeId: string): void =>
{
    const next = new Set(expandedNodeIds.value);
    if (next.has(nodeId))
    {
        next.delete(nodeId);
    }
    else
    {
        next.add(nodeId);
    }
    expandedNodeIds.value = next;
};

const revealHeading = (item: MarkdownEditorOutlineItem): void =>
{
    emit('reveal-heading', item);
};

const revealRange = (item: MarkdownEditorOutlineItem): void =>
{
    emit('reveal-range', item);
};
</script>

<style scoped>
.article-write-outline-launcher
 {
    position: fixed;
    z-index: var(--fsusblog-z-sticky, 30);
    top: calc(var(--fsus-space-8) * 2);
    left: var(--fsus-space-4);
    display: inline-grid;
    width: var(--fsus-control-height-spacious);
    height: var(--fsus-control-height-spacious);
    cursor: pointer;
    place-items: center;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-muted);
}

.article-write-outline-launcher:hover,
.article-write-outline-launcher:focus-visible
 {
    color: var(--fsus-scholarly-blue);
}

.article-write-outline-launcher:focus-visible
 {
    outline: 2px solid var(--fsusblog-color-focus-ring);
    outline-offset: -2px;
}

.article-write-outline-panel
 {
    position: fixed;
    z-index: var(--fsusblog-z-sticky, 30);
    top: calc(var(--fsus-space-8) * 2);
    bottom: calc(var(--fsus-control-height-spacious) + var(--fsus-space-8));
    left: var(--fsus-space-4);
    display: grid;
    width: min(20rem, 24vw);
    min-width: 15rem;
    min-height: 0;
    grid-template-rows: minmax(0, 1fr);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-primary);
}

.article-write-outline-drawer-content
 {
    display: grid;
    min-height: 100%;
    grid-template-rows: minmax(0, 1fr);
}

.article-write-outline-visually-hidden
 {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
}

@media (width <= 1023px)
 {
    .article-write-outline-launcher
     {
        top: var(--fsus-space-3);
        left: var(--fsus-space-3);
    }
}
</style>
