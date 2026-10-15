<template>
    <FsusUiButton
        v-if="!isOpen"
        ref="launcherRef"
        native-type="button"
        class="article-write-outline-launcher"
        aria-label="打开文章大纲"
        :aria-controls="resolvedPanelId"
        :aria-expanded="isOpen"
        data-article-outline-launcher="true"
        @click="openRail"
    >
        <ElIcon aria-hidden="true">
            <List />
        </ElIcon>
        <span class="article-write-outline-visually-hidden">打开文章大纲</span>
    </FsusUiButton>

    <component
        v-if="isCompact || isOpen"
        :is="outlineHost"
        v-bind="outlineHostProperties"
        @update:model-value="handleHostVisibility"
        @closed="handleClosed"
    >
        <aside
            v-if="!isCompact"
            :id="resolvedPanelId"
            class="article-write-outline-panel"
            role="complementary"
            :aria-labelledby="resolvedTitleId"
            data-article-outline-panel="true"
        >
            <OutlinePanelContent
                :title-id="resolvedTitleId"
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
            :id="resolvedPanelId"
            class="article-write-outline-drawer-content"
            role="region"
            :aria-labelledby="resolvedTitleId"
            data-article-outline-panel="true"
        >
            <OutlinePanelContent
                :title-id="resolvedTitleId"
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
    defineComponent,
    h,
    nextTick,
    onMounted,
    ref,
    resolveComponent,
    useId,
    watch,
    type PropType
} from 'vue';

import type {
    ArticleOutlineSnapshot
} from '@/composables/useArticleOutline';
import {
    flattenArticleOutlineTree
} from '@/composables/useArticleOutline';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { FsusUiButton } from '@/fsusui/button';
import { Close, List } from '@/fsusui/icons';
import type { MarkdownEditorOutlineItem, MarkdownOutlineTreeNode } from '@ozwasyd/element-plus';

defineOptions({ name: 'ArticleWriteOutlineRail' });

/** Only ButtonInstance.ref's documented native button is consumed. */
interface OutlineButtonHandle
{
    readonly ref?: HTMLButtonElement;
}

const RAIL_OPEN_STORAGE_KEY = 'fsusblog.article-outline.rail-open.v1';

const diagnosticLabels: Record<string, string> = {
    'duplicate-h1': '重复的一级标题',
    'heading-layer-jump': '标题层级跳跃'
};

const OutlinePanelContent = defineComponent({
    name: 'ArticleWriteOutlinePanelContent',
    props: {
        titleId: {
            type: String,
            required: true
        },
        snapshot: {
            type: Object as PropType<ArticleOutlineSnapshot | null>,
            default: null
        },
        activeHeadingId: {
            type: String as PropType<string | null>,
            default: null
        },
        expandedNodeIds: {
            type: Object as PropType<ReadonlySet<string>>,
            required: true
        }
    },
    emits: {
        'toggle-node': (nodeId: string) => typeof nodeId === 'string',
        'reveal-heading': (item: MarkdownEditorOutlineItem) => Boolean(item),
        'reveal-range': (item: MarkdownEditorOutlineItem) => Boolean(item),
        close: () => true
    },
    setup(props, { emit }) {
        const treeRef = ref<HTMLElement | null>(null);
        const nodeButtons = new Map<string, HTMLButtonElement>();
        const expanded = computed(() => props.expandedNodeIds);
        const visibleNodes = computed(() => flattenArticleOutlineTree(
            props.snapshot?.tree ?? [],
            expanded.value
        ));
        const hasHeadings = computed(() => (props.snapshot?.items.length ?? 0) > 0);
        const status = computed(() => {
            if (!props.snapshot) return 'stale';
            return hasHeadings.value ? 'ready' : 'empty';
        });

        const registerNodeButton = (nodeId: string, element: unknown): void => {
            const button = (element as OutlineButtonHandle | null)?.ref;
            if (button instanceof HTMLButtonElement) {
                nodeButtons.set(nodeId, button);
                return;
            }
            nodeButtons.delete(nodeId);
        };

        const focusNode = (nodeId: string | undefined): void => {
            if (!nodeId) return;
            nextTick(() => nodeButtons.get(nodeId)?.focus({ preventScroll: true }));
        };

        const nodeIndex = (nodeId: string | undefined): number =>
            visibleNodes.value.findIndex((node) => node.nodeId === nodeId);

        const parentNode = (node: MarkdownOutlineTreeNode): MarkdownEditorOutlineItem | null => {
            const parentId = node.parentId;
            if (!parentId || !props.snapshot) return null;
            return props.snapshot.items.find((item) => item.nodeId === parentId) ?? null;
        };

        const handleTreeKeydown = (event: KeyboardEvent): void => {
            const target = event.target;
            if (!(target instanceof HTMLButtonElement) || target.getAttribute('role') !== 'treeitem') {
                return;
            }
            const node = visibleNodes.value.find((item) => item.nodeId === target.dataset.outlineNodeId);
            if (!node) return;
            const index = nodeIndex(node.nodeId);
            const previous = visibleNodes.value[index - 1];
            const next = visibleNodes.value[index + 1];
            switch (event.key) {
                case 'ArrowDown':
                    event.preventDefault();
                    focusNode(next?.nodeId);
                    break;
                case 'ArrowUp':
                    event.preventDefault();
                    focusNode(previous?.nodeId);
                    break;
                case 'Home':
                    event.preventDefault();
                    focusNode(visibleNodes.value[0]?.nodeId);
                    break;
                case 'End':
                    event.preventDefault();
                    focusNode(visibleNodes.value[visibleNodes.value.length - 1]?.nodeId);
                    break;
                case 'ArrowRight':
                    event.preventDefault();
                    if (node.children.length > 0 && !expanded.value.has(node.nodeId)) {
                        emit('toggle-node', node.nodeId);
                    } else if (node.children.length > 0) {
                        focusNode(node.children[0]?.nodeId);
                    }
                    break;
                case 'ArrowLeft': {
                    event.preventDefault();
                    if (node.children.length > 0 && expanded.value.has(node.nodeId)) {
                        emit('toggle-node', node.nodeId);
                    } else {
                        focusNode(parentNode(node)?.nodeId);
                    }
                    break;
                }
                case 'Enter':
                case ' ':
                    event.preventDefault();
                    emit('reveal-heading', node);
                    break;
                case 'Escape':
                    event.preventDefault();
                    emit('close');
                    break;
                default:
                    break;
            }
        };

        return () => h('div', {
            class: 'article-write-outline-content',
            'data-article-outline-status': status.value
        }, [
            h('header', { class: 'article-write-outline-header' }, [
                h('h2', { id: props.titleId, class: 'article-write-outline-title' }, '文章大纲'),
                h(FsusUiButton, {
                    nativeType: 'button',
                    class: 'article-write-outline-close',
                    'aria-label': '关闭文章大纲',
                    onClick: () => emit('close')
                }, () => [h(resolveComponent('ElIcon'), { 'aria-hidden': 'true' }, () => [h(Close)])])
            ]),
            status.value === 'stale'
                ? h('p', { class: 'article-write-outline-message', role: 'status' }, '文章大纲正在同步。')
                : status.value === 'empty'
                    ? h('p', { class: 'article-write-outline-message' }, '正文中暂无标题。')
                    : h('nav', {
                        ref: treeRef,
                        class: 'article-write-outline-tree-wrap',
                        'aria-label': '文章大纲'
                    }, [h('div', {
                        class: 'article-write-outline-tree',
                        role: 'tree',
                        tabindex: '-1',
                        onKeydown: handleTreeKeydown
                    }, visibleNodes.value.map((node, index) => h('div', {
                        key: node.nodeId,
                        class: 'article-write-outline-node',
                        'data-outline-node': node.nodeId
                    }, [
                        h(FsusUiButton, {
                            ref: (element) => registerNodeButton(node.nodeId, element),
                            nativeType: 'button',
                            class: [
                                'article-write-outline-item',
                                { 'is-active': props.activeHeadingId === node.nodeId }
                            ],
                            role: 'treeitem',
                            tabindex: props.activeHeadingId === node.nodeId || index === 0 ? '0' : '-1',
                            'aria-level': String(node.depth),
                            'aria-posinset': String(index + 1),
                            'aria-setsize': String(visibleNodes.value.length),
                            'aria-selected': props.activeHeadingId === node.nodeId ? 'true' : 'false',
                            'aria-expanded': node.children.length > 0 ? String(expanded.value.has(node.nodeId)) : undefined,
                            'aria-label': node.text || '无标题',
                            title: node.text || '无标题',
                            'data-outline-node-id': node.nodeId,
                            style: { '--article-outline-depth': String(Math.max(0, node.depth - 1)) },
                            onClick: () => emit('reveal-heading', node)
                        }, () => [
                            node.children.length > 0
                                ? h('span', {
                                    class: 'article-write-outline-disclosure',
                                    'aria-hidden': 'true',
                                    onClick: (event: MouseEvent) => {
                                        event.stopPropagation();
                                        emit('toggle-node', node.nodeId);
                                    }
                                }, expanded.value.has(node.nodeId) ? '▾' : '▸')
                                : h('span', { class: 'article-write-outline-disclosure-placeholder', 'aria-hidden': 'true' }),
                            h('span', { class: 'article-write-outline-item-text', title: node.text || '无标题' }, node.text || '无标题')
                        ]),
                        node.diagnostics.length > 0
                            ? h('div', {
                                class: 'article-write-outline-diagnostics',
                                role: 'group',
                                'aria-label': '大纲诊断'
                            }, node.diagnostics.map((diagnostic) => h(FsusUiButton, {
                                key: `${node.nodeId}:${diagnostic.code}`,
                                nativeType: 'button',
                                class: 'article-write-outline-diagnostic',
                                'data-outline-diagnostic': diagnostic.code,
                                onClick: () => emit('reveal-range', node)
                            }, () => diagnosticLabels[diagnostic.code] ?? diagnostic.code)))
                            : null
                    ]))),
            ])
        ]);
    }
});

const props = withDefaults(defineProps<{
    snapshot: ArticleOutlineSnapshot | null;
    activeHeadingId?: string | null;
    panelId?: string;
    titleId?: string;
}>(), {
    activeHeadingId: null
});

const instanceId = useId();
const resolvedPanelId = computed(() => props.panelId ?? `${instanceId}-article-outline-panel`);
const resolvedTitleId = computed(() => props.titleId ?? `${resolvedPanelId.value}-title`);

const emit = defineEmits<{
    (event: 'reveal-heading', item: MarkdownEditorOutlineItem): void;
    (event: 'reveal-range', item: MarkdownEditorOutlineItem): void;
}>();

const isCompact = useMediaQuery('(max-width: 1023px)', false);
const publicDrawer = resolveComponent('ElDrawer');
const isOpen = ref(false);
const launcherRef = ref<OutlineButtonHandle | null>(null);
const expandedNodeIds = ref<ReadonlySet<string>>(new Set());
let focusReturnPending = false;
let mounted = false;

const outlineHost = computed(() => isCompact.value ? publicDrawer : 'aside');
const outlineHostProperties = computed(() => isCompact.value
    ? {
        modelValue: isOpen.value,
        title: '文章大纲',
        direction: 'ltr',
        size: 'min(86vw, 22rem)',
        modal: true,
        lockScroll: true,
        closeOnClickModal: true,
        destroyOnClose: false,
        class: 'article-write-outline-drawer'
    }
    : {
        id: `${resolvedPanelId.value}-host`,
        hidden: !isOpen.value,
        role: 'complementary',
        'aria-label': '文章大纲',
        class: 'article-write-outline-panel-host'
    });

const collectExpandableNodeIds = (tree: readonly MarkdownOutlineTreeNode[]): ReadonlySet<string> => {
    const ids = new Set<string>();
    const visit = (nodes: readonly MarkdownOutlineTreeNode[]): void => {
        nodes.forEach((node) => {
            if (node.children.length > 0) {
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
], () => {
    const snapshot = props.snapshot;
    const nextKey = snapshot
        ? `${snapshot.articleIdentity}\u0000${snapshot.documentIdentity.id}\u0000${snapshot.documentIdentity.epoch}`
        : '';
    const available = snapshot ? collectExpandableNodeIds(snapshot.tree) : new Set<string>();
    if (nextKey !== expandedSnapshotKey) {
        expandedNodeIds.value = available;
        expandedSnapshotKey = nextKey;
        return;
    }
    expandedNodeIds.value = new Set(
        [...expandedNodeIds.value].filter((nodeId) => available.has(nodeId))
    );
}, { immediate: true });

const writeRailPreference = (value: boolean): void => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(RAIL_OPEN_STORAGE_KEY, String(value));
    } catch {
        // Private browsing and blocked storage do not affect the editor.
    }
};

const readRailPreference = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        const value = window.localStorage.getItem(RAIL_OPEN_STORAGE_KEY);
        return value === 'true';
    } catch {
        return false;
    }
};

watch(isOpen, (value) => {
    if (mounted) writeRailPreference(value);
});

onMounted(() => {
    mounted = true;
    isOpen.value = readRailPreference();
});

const focusLauncher = (): void => {
    if (!focusReturnPending) return;
    focusReturnPending = false;
    void nextTick(() => {
        if (!isCompact.value) {
            launcherRef.value?.ref?.focus({ preventScroll: true });
            return;
        }
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            launcherRef.value?.ref?.focus({ preventScroll: true });
            return;
        }
        window.requestAnimationFrame(() => launcherRef.value?.ref?.focus({ preventScroll: true }));
    });
};

const openRail = (): void => {
    focusReturnPending = false;
    isOpen.value = true;
};

const requestClose = (): void => {
    if (!isOpen.value) return;
    focusReturnPending = true;
    isOpen.value = false;
    if (!isCompact.value) focusLauncher();
};

const handleHostVisibility = (visible: boolean): void => {
    if (visible) {
        openRail();
        return;
    }
    requestClose();
};

const handleClosed = (): void => {
    if (isCompact.value) focusLauncher();
};

const toggleNode = (nodeId: string): void => {
    const next = new Set(expandedNodeIds.value);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    expandedNodeIds.value = next;
};

const revealHeading = (item: MarkdownEditorOutlineItem): void => {
    emit('reveal-heading', item);
};

const revealRange = (item: MarkdownEditorOutlineItem): void => {
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

.article-write-outline-launcher:focus-visible,
.article-write-outline-close:focus-visible,
.article-write-outline-item:focus-visible,
.article-write-outline-diagnostic:focus-visible
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

.article-write-outline-content
 {
    display: grid;
    min-height: 0;
    grid-template-rows: auto minmax(0, 1fr);
}

.article-write-outline-header
 {
    display: flex;
    min-height: var(--fsus-control-height-spacious);
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    padding-inline: var(--fsus-space-4) var(--fsus-space-2);
}

.article-write-outline-title
 {
    margin: 0;
    font-size: var(--fsus-typography-heading-sm-size);
    font-weight: 700;
    line-height: 1.35;
}

.article-write-outline-close
 {
    display: inline-grid;
    width: var(--fsus-control-height);
    height: var(--fsus-control-height);
    cursor: pointer;
    place-items: center;
    border: 0;
    border-radius: var(--fsus-radius-control);
    background: transparent;
    color: var(--fsusblog-text-muted);
}

.article-write-outline-tree-wrap
 {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--fsus-space-2);
}

.article-write-outline-tree
 {
    display: grid;
    gap: var(--fsus-space-1);
}

.article-write-outline-item
 {
    display: flex;
    width: 100%;
    min-height: var(--fsus-control-height);
    align-items: center;
    gap: var(--fsus-space-1);
    cursor: pointer;
    border: 0;
    border-radius: var(--fsus-radius-control-small);
    padding: var(--fsus-space-1) var(--fsus-space-2);
    padding-inline-start: calc(
        var(--fsus-space-2) + var(--article-outline-depth, 0) * var(--fsus-space-4)
    );
    background: transparent;
    color: var(--fsusblog-text-primary);
    font: inherit;
    line-height: 1.4;
    text-align: start;
}

.article-write-outline-item:hover,
.article-write-outline-item.is-active
 {
    background: var(--fsus-state-selected-bg, var(--fsusblog-page-bg-soft));
}

.article-write-outline-item.is-active
 {
    color: var(--fsus-scholarly-blue);
    font-weight: 700;
}

.article-write-outline-disclosure,
.article-write-outline-disclosure-placeholder
 {
    display: inline-grid;
    width: 1rem;
    flex: 0 0 1rem;
    place-items: center;
    color: var(--fsusblog-text-muted);
}

.article-write-outline-disclosure
 {
    cursor: pointer;
}

.article-write-outline-item-text
 {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.article-write-outline-diagnostics
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-1);
    padding: 0 var(--fsus-space-2) var(--fsus-space-1);
}

.article-write-outline-diagnostic
 {
    cursor: pointer;
    border: 0;
    border-bottom: 1px dashed var(--fsusblog-panel-border);
    background: transparent;
    color: var(--fsusblog-text-tertiary);
    font: inherit;
    font-size: 12px;
}

.article-write-outline-message
 {
    margin: var(--fsus-space-4);
    color: var(--fsusblog-text-tertiary);
    line-height: 1.5;
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

@media (max-width: 1023px)
 {
    .article-write-outline-launcher
     {
        top: var(--fsus-space-3);
        left: var(--fsus-space-3);
     }
 }
</style>
