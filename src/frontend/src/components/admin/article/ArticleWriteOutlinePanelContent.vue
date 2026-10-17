<script lang="ts">
import {
    computed,
    defineComponent,
    h,
    nextTick,
    onBeforeUnmount,
    ref,
    resolveComponent,
    watch,
    type PropType
} from 'vue';

import type { MarkdownEditorOutlineItem, MarkdownOutlineTreeNode } from '@ozwasyd/element-plus';

import type {
    ArticleOutlineSnapshot
} from '@/composables/useArticleOutline';
import {
    flattenArticleOutlineTree
} from '@/composables/useArticleOutline';
import { Close } from '@/fsusui/icons';

const diagnosticLabels: Record<string, string> = {
    'duplicate-h1': '重复的一级标题',
    'heading-layer-jump': '标题层级跳跃'
};

export default defineComponent({
    name: 'ArticleWriteOutlinePanelContent',
    props: {
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
    setup(props, { emit })
    {
        const treeRef = ref<HTMLElement | null>(null);
        const nodeButtons = new Map<string, HTMLButtonElement>();
        const rovingNodeId = ref<string | null>(null);
        let nodeFocusGeneration = 0;
        let contentDisposed = false;
        const expanded = computed(() => props.expandedNodeIds);
        const visibleNodes = computed(() => flattenArticleOutlineTree(
            props.snapshot?.tree ?? [],
            expanded.value
        ));
        const visibleNodeIds = computed(() => new Set(visibleNodes.value.map((node) => node.nodeId)));
        const tabStopNodeId = computed(() =>
        {
            let candidate = rovingNodeId.value;
            while (candidate)
            {
                if (visibleNodeIds.value.has(candidate))
                {
                    return candidate;
                }
                candidate = props.snapshot?.items.find((item) => item.nodeId === candidate)?.parentId ?? null;
            }
            if (props.activeHeadingId && visibleNodeIds.value.has(props.activeHeadingId))
            {
                return props.activeHeadingId;
            }
            return visibleNodes.value[0]?.nodeId ?? null;
        });
        const siblingMetadata = computed(() =>
        {
            const metadata = new Map<string, Record<string, string>>();
            const visit = (siblings: readonly MarkdownOutlineTreeNode[], level: number): void =>
            {
                siblings.forEach((node, index) =>
                {
                    metadata.set(node.nodeId, {
                        'aria-level': String(level),
                        'aria-posinset': String(index + 1),
                        'aria-setsize': String(siblings.length)
                    });
                    visit(node.children, level + 1);
                });
            };
            visit(props.snapshot?.tree ?? [], 1);
            return metadata;
        });
        const hasHeadings = computed(() => (props.snapshot?.items.length ?? 0) > 0);
        const status = computed(() =>
        {
            if (!props.snapshot)
            {
                return 'stale';
            }
            return hasHeadings.value ? 'ready' : 'empty';
        });

        const registerNodeButton = (nodeId: string, element: Element | null): void =>
        {
            if (element instanceof HTMLButtonElement)
            {
                nodeButtons.set(nodeId, element);
                return;
            }
            nodeButtons.delete(nodeId);
        };

        // Return queued focus failures through the originating Vue event handler.
        const focusNode = async (nodeId: string | undefined): Promise<void> =>
        {
            const generation = ++nodeFocusGeneration;
            if (!nodeId || !visibleNodeIds.value.has(nodeId))
            {
                return;
            }
            rovingNodeId.value = nodeId;
            await nextTick();
            if (!contentDisposed && generation === nodeFocusGeneration && visibleNodeIds.value.has(nodeId))
            {
                nodeButtons.get(nodeId)?.focus({ preventScroll: true });
            }
        };

        watch(() => props.snapshot, (snapshot, previous) =>
        {
            nodeFocusGeneration += 1;
            if (snapshot?.articleIdentity !== previous?.articleIdentity
                || snapshot?.documentIdentity.id !== previous?.documentIdentity.id
                || snapshot?.documentIdentity.epoch !== previous?.documentIdentity.epoch)
            {
                rovingNodeId.value = null;
            }
        }, { flush: 'sync' });

        watch(visibleNodes, async () =>
        {
            const current = rovingNodeId.value;
            if (!current || visibleNodeIds.value.has(current))
            {
                return;
            }
            const ownedFocus = typeof document !== 'undefined' && nodeButtons.get(current) === document.activeElement;
            const fallback = tabStopNodeId.value;
            rovingNodeId.value = fallback;
            if (ownedFocus)
            {
                await focusNode(fallback ?? undefined);
            }
        }, { flush: 'sync' });

        onBeforeUnmount(() =>
        {
            contentDisposed = true;
            nodeFocusGeneration += 1;
            nodeButtons.clear();
        });

        const nodeIndex = (nodeId: string | undefined): number =>
            visibleNodes.value.findIndex((node) => node.nodeId === nodeId);

        const parentNode = (node: MarkdownOutlineTreeNode): MarkdownEditorOutlineItem | null =>
        {
            const parentId = node.parentId;
            if (!parentId || !props.snapshot)
            {
                return null;
            }
            return props.snapshot.items.find((item) => item.nodeId === parentId) ?? null;
        };

        const handleTreeKeydown = async (event: KeyboardEvent): Promise<void> =>
        {
            const target = event.target;
            if (!(target instanceof HTMLButtonElement) || target.getAttribute('role') !== 'treeitem')
            {
                return;
            }
            const node = visibleNodes.value.find((item) => item.nodeId === target.dataset.outlineNodeId);
            if (!node)
            {
                return;
            }
            const index = nodeIndex(node.nodeId);
            const previous = visibleNodes.value[index - 1];
            const next = visibleNodes.value[index + 1];
            switch (event.key)
            {
                case 'ArrowDown':
                    event.preventDefault();
                    await focusNode(next?.nodeId);
                    break;
                case 'ArrowUp':
                    event.preventDefault();
                    await focusNode(previous?.nodeId);
                    break;
                case 'Home':
                    event.preventDefault();
                    await focusNode(visibleNodes.value[0]?.nodeId);
                    break;
                case 'End':
                    event.preventDefault();
                    await focusNode(visibleNodes.value[visibleNodes.value.length - 1]?.nodeId);
                    break;
                case 'ArrowRight':
                    event.preventDefault();
                    if (node.children.length > 0 && !expanded.value.has(node.nodeId))
                    {
                        emit('toggle-node', node.nodeId);
                    }
                    else if (node.children.length > 0)
                    {
                        await focusNode(node.children[0]?.nodeId);
                    }
                    break;
                case 'ArrowLeft': {
                    event.preventDefault();
                    if (node.children.length > 0 && expanded.value.has(node.nodeId))
                    {
                        emit('toggle-node', node.nodeId);
                    }
                    else
                    {
                        await focusNode(parentNode(node)?.nodeId);
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
                h('h2', { class: 'article-write-outline-title' }, '文章大纲'),
                h('button', {
                    type: 'button',
                    class: 'article-write-outline-close',
                    'aria-label': '关闭文章大纲',
                    onClick: () => emit('close')
                }, [h(resolveComponent('ElIcon'), { 'aria-hidden': 'true' }, () => [h(Close)])])
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
                    }, visibleNodes.value.map((node) => h('div', {
                        key: node.nodeId,
                        class: 'article-write-outline-node',
                        'data-outline-node': node.nodeId
                    }, [
                        h('button', {
                            ref: (element) => registerNodeButton(node.nodeId, element),
                            type: 'button',
                            class: [
                                'article-write-outline-item',
                                { 'is-active': props.activeHeadingId === node.nodeId }
                            ],
                            role: 'treeitem',
                            tabindex: tabStopNodeId.value === node.nodeId ? '0' : '-1',
                            ...siblingMetadata.value.get(node.nodeId),
                            'aria-selected': props.activeHeadingId === node.nodeId ? 'true' : 'false',
                            'aria-expanded': node.children.length > 0 ? String(expanded.value.has(node.nodeId)) : undefined,
                            'aria-label': node.text || '无标题',
                            title: node.text || '无标题',
                            'data-outline-node-id': node.nodeId,
                            style: { '--article-outline-depth': String(Math.max(0, node.depth - 1)) },
                            onFocus: () =>
                            {
                                nodeFocusGeneration += 1;
                                rovingNodeId.value = node.nodeId;
                            },
                            onClick: () =>
                            {
                                nodeFocusGeneration += 1;
                                rovingNodeId.value = node.nodeId;
                                emit('reveal-heading', node);
                            }
                        }, [
                            node.children.length > 0
                                ? h('span', {
                                    class: 'article-write-outline-disclosure',
                                    'aria-hidden': 'true',
                                    onClick: (event: MouseEvent) =>
                                    {
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
                            }, node.diagnostics.map((diagnostic) => h('button', {
                                key: `${node.nodeId}:${diagnostic.code}`,
                                type: 'button',
                                class: 'article-write-outline-diagnostic',
                                'data-outline-diagnostic': diagnostic.code,
                                onClick: () => emit('reveal-range', node)
                            }, diagnosticLabels[diagnostic.code] ?? diagnostic.code)))
                            : null
                    ])))
                    ])
        ]);
    }
});

</script>

<style scoped>
.article-write-outline-close:focus-visible,
.article-write-outline-item:focus-visible,
.article-write-outline-diagnostic:focus-visible
 {
    outline: 2px solid var(--fsusblog-color-focus-ring);
    outline-offset: -2px;
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

</style>
