<template>
    <div
        class="article-write-inspector-shell"
        :data-active-inspector="activeInspector ?? 'closed'"
        :data-inspector-mode="isCompact ? 'modal' : 'nonmodal'"
    >
        <ArticleWriteInspectorRail
            v-if="!isCompact"
            :active-inspector="activeInspector"
            placement="desktop"
            :register-trigger-element="registerTriggerElement"
            @activate="handleRailActivate"
        />

        <button
            v-if="isCompact"
            v-show="activeInspector === null"
            type="button"
            class="article-write-inspector-launcher"
            aria-label="打开文章检查器"
            aria-controls="article-write-inspector-view-publish"
            :aria-expanded="activeInspector !== null"
            @click="activate('publish', $event)"
        >
            <ElIcon aria-hidden="true">
                <Checked />
            </ElIcon>
        </button>

        <component
            :is="inspectorHost"
            v-bind="inspectorHostProperties"
            @update:model-value="handleDrawerVisibility"
            @closed="handleClosed"
        >
            <ArticleWriteInspectorRail
                v-if="isCompact"
                :active-inspector="activeInspector"
                placement="drawer"
                :register-trigger-element="registerTriggerElement"
                @activate="handleRailActivate"
            />

            <header
                v-if="!isCompact"
                class="article-write-inspector-pane__header"
            >
                <h2 class="article-write-inspector-pane__title">
                    {{ activeView?.label ?? '文章检查器' }}
                </h2>
                <button
                    type="button"
                    class="article-write-inspector-pane__close"
                    aria-label="关闭文章检查器"
                    @click="requestClose"
                >
                    <ElIcon aria-hidden="true">
                        <Close />
                    </ElIcon>
                </button>
            </header>

            <div class="article-write-inspector-views">
                <section
                    v-for="view in inspectorViews"
                    v-show="activeInspector === view.id"
                    :id="`article-write-inspector-view-${view.id}`"
                    :key="view.id"
                    :ref="(element) => registerScrollContainer(view.id, element)"
                    class="article-write-inspector-view"
                    :data-inspector-view="view.id"
                    :aria-label="view.label"
                    :aria-hidden="activeInspector !== view.id"
                    :inert="activeInspector !== view.id"
                    @scroll="handleScroll(view.id, $event)"
                >
                    <slot :name="view.id" />
                    <template v-if="view.id === 'check' && activeInspector === 'check'">
                        <section
                            v-for="entry in inspectorModels"
                            :key="entry.result.binding.viewId"
                            :aria-label="entry.session.authority.localize(entry.result.model.titleReference)"
                            data-authoring-inspector-model
                        >
                            <h3>{{ entry.session.authority.localize(entry.result.model.titleReference) }}</h3>
                            <p
                                v-if="entry.result.model.state !== 'ready'"
                                role="status"
                            >
                                {{ inspectorStateLabels[entry.result.model.state] }}
                            </p>
                            <template
                                v-for="node in entry.result.model.nodes"
                                :key="node.id"
                            >
                                <ElDescriptions
                                    v-if="node.kind === 'values'"
                                    :column="1"
                                    responsive="auto"
                                >
                                    <ElDescriptionsItem
                                        v-for="row in node.rows"
                                        :key="row.id"
                                        :label="entry.session.authority.localize(row.labelReference)"
                                    >{{ row.value }}</ElDescriptionsItem>
                                </ElDescriptions>
                                <ul v-else-if="node.kind === 'list'">
                                    <li
                                        v-for="(item, index) in node.items"
                                        :key="index"
                                    >{{ item }}</li>
                                </ul>
                                <ElTable
                                    v-else-if="node.kind === 'table'"
                                    :data="node.rows"
                                    row-key="id"
                                >
                                    <ElTableColumn
                                        v-for="(column, index) in node.columns"
                                        :key="column.id"
                                        :label="entry.session.authority.localize(column.labelReference)"
                                    >
                                        <template #default="scope">{{ scope.row.cells[index] }}</template>
                                    </ElTableColumn>
                                </ElTable>
                                <p
                                    v-else-if="node.kind === 'status'"
                                    role="status"
                                >
                                    {{ entry.session.authority.localize(node.messageReference) }}
                                </p>
                                <p v-else-if="node.kind === 'diagnostic'">
                                    {{ node.severity }}: {{ entry.session.authority.localize(node.messageReference) }} ({{ node.code }})
                                </p>
                            </template>
                            <ElButton
                                v-for="command in entry.result.model.commands"
                                :key="command.commandId"
                                :disabled="!entry.session.authority.commandEnabled(entry.result.binding, command.commandId)"
                                @click="requestInspectorCommand(entry.session, command.commandId)"
                            >{{ entry.session.authority.localize(command.labelReference) }}</ElButton>
                        </section>
                    </template>
                </section>
            </div>
        </component>
    </div>
</template>

<script setup lang="ts">
import { ElButton, ElDescriptions, ElDescriptionsItem, ElTable, ElTableColumn } from '@ozwasyd/element-plus';
import {
    computed,
    nextTick,
    onMounted,
    onUnmounted,
    ref,
    resolveComponent,
    watch,
    type ComponentPublicInstance
} from 'vue';

import ArticleWriteInspectorRail from '@/components/admin/article/ArticleWriteInspectorRail.vue';
import {
    articleWriteInspectorRegistry,
    type ArticleWriteInspectorView
} from '@/composables/useArticleWriteInspector';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { authoringInspectorBudgets, inspectorBindingIsCurrent } from '@/fsusui/authoringInspector';
import type { AuthoringInspectorBinding, AuthoringInspectorSession } from '@/fsusui/authoringInspector';
import { Checked, Close } from '@/fsusui/icons';

const props = defineProps<{
    activeInspector: ArticleWriteInspectorView | null;
    registerTriggerElement?: (view: ArticleWriteInspectorView, element: HTMLElement | null) => void;
    registerScrollElement?: (view: ArticleWriteInspectorView, element: HTMLElement | null) => void;
    inspectorSessions?: readonly AuthoringInspectorSession[];
}>();

const emit = defineEmits<{
    (event: 'activate', view: ArticleWriteInspectorView, trigger: HTMLElement): void;
    (event: 'switch', view: ArticleWriteInspectorView): void;
    (event: 'close'): void;
    (event: 'closed'): void;
    (event: 'scroll', view: ArticleWriteInspectorView, scrollTop: number): void;
    (event: 'inspector-command', binding: AuthoringInspectorBinding, commandId: string): void;
}>();

const inspectorStateLabels = {
    loading: '加载中', empty: '暂无结果', error: '检查器请求失败',
    permission: '缺少读取权限', unsupported: '不支持此检查器'
};
const inspectorGeneration = ref(0);
let detachInspectorSessions: (() => void)[] = [];
watch(() => props.inspectorSessions, (sessions, previousSessions) =>
{
    for (const detach of detachInspectorSessions)
    {
        detach();
    }
    detachInspectorSessions = [];
    for (const session of previousSessions ?? [])
    {
        if (!sessions?.includes(session))
        {
            session.cancel();
        }
    }
    if ((sessions?.length ?? 0) > authoringInspectorBudgets.active)
    {
        for (const session of sessions ?? [])
        {
            session.cancel();
        }
        return;
    }
    detachInspectorSessions = (sessions ?? []).map((session) => session.subscribe(() => inspectorGeneration.value++));
    if (props.activeInspector !== 'check')
    {
        for (const session of sessions ?? [])
        {
            session.cancel();
        }
    }
}, { immediate: true });
watch(() => props.activeInspector, (view) =>
{
    if (view !== 'check')
    {
        for (const session of props.inspectorSessions ?? [])
        {
            session.cancel();
        }
    }
});
const inspectorModels = computed(() =>
{
    void inspectorGeneration.value;
    const sessions = props.inspectorSessions ?? [];
    if (sessions.length > authoringInspectorBudgets.active)
    {
        return [];
    }
    const entries = sessions.flatMap((session) =>
    {
        const result = session.current;
        return result ? [{ session, result }] : [];
    });
    if (new Set(entries.map((entry) => entry.result.binding.viewId)).size !== entries.length)
    {
        return [];
    }
    return entries;
});
const requestInspectorCommand = (session: AuthoringInspectorSession, commandId: string): void =>
{
    const result = session.current;
    if (props.activeInspector !== 'check' || !result ||
        !inspectorBindingIsCurrent(result.binding, session.authority) ||
        !result.model.commands.some((command) => command.commandId === commandId) ||
        !session.authority.commandEnabled(result.binding, commandId))
    {
        return;
    }
    if (props.activeInspector !== 'check' || session.current !== result)
    {
        return;
    }
    emit('inspector-command', result.binding, commandId);
};
onUnmounted(() =>
{
    for (const detach of detachInspectorSessions)
    {
        detach();
    }
    for (const session of props.inspectorSessions ?? [])
    {
        session.cancel();
    }
});

const inspectorViews = articleWriteInspectorRegistry;

const isCompact = useMediaQuery('(max-width: 1023px)', false);
const publicDrawer = resolveComponent('ElDrawer');
const activeView = computed(() => (
    inspectorViews.find((view) => view.id === props.activeInspector) ?? null
));
const inspectorHost = computed(() => isCompact.value ? publicDrawer : 'aside');
const inspectorHostProperties = computed(() =>
{
    if (isCompact.value)
    {
        return {
            modelValue: props.activeInspector !== null,
            title: activeView.value?.label ?? '文章检查器',
            direction: 'rtl',
            size: '100%',
            modal: true,
            lockScroll: true,
            closeOnClickModal: true,
            destroyOnClose: false,
            class: 'article-write-inspector-drawer'
        };
    }

    return {
        id: 'article-write-inspector-pane',
        hidden: props.activeInspector === null,
        role: 'complementary',
        'aria-label': activeView.value?.label ?? '文章检查器',
        class: 'article-write-inspector-pane'
    };
});

const resolveElement = (
    element: Element | ComponentPublicInstance | null
): HTMLElement | null =>
{
    if (element instanceof HTMLElement)
    {
        return element;
    }
    if (element === null || !('$el' in element))
    {
        return null;
    }
    const componentElement: unknown = element.$el;
    return componentElement instanceof HTMLElement ? componentElement : null;
};

const registerScrollContainer = (
    view: ArticleWriteInspectorView,
    element: Element | ComponentPublicInstance | null
): void =>
{
    props.registerScrollElement?.(view, resolveElement(element));
};

const activate = (view: ArticleWriteInspectorView, event: MouseEvent): void =>
{
    emit('activate', view, event.currentTarget as HTMLElement);
};

const handleRailActivate = (
    view: ArticleWriteInspectorView,
    trigger: HTMLElement
): void =>
{
    if (isCompact.value && props.activeInspector !== null)
    {
        emit('switch', view);
        return;
    }

    emit('activate', view, trigger);
};

const handleDrawerVisibility = (visible: boolean): void =>
{
    if (!visible)
    {
        emit('close');
    }
};

const handleClosed = (): void =>
{
    if (isCompact.value)
    {
        emit('closed');
    }
};

const requestClose = (): void =>
{
    emit('close');
    if (!isCompact.value)
    {
        void nextTick(() => emit('closed'));
    }
};

const handleScroll = (view: ArticleWriteInspectorView, event: Event): void =>
{
    emit('scroll', view, (event.currentTarget as HTMLElement).scrollTop);
};

const handleKeydown = (event: KeyboardEvent): void =>
{
    if (!isCompact.value && props.activeInspector !== null && event.key === 'Escape')
    {
        event.preventDefault();
        requestClose();
    }
};

onMounted(() =>
{
    window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() =>
{
    window.removeEventListener('keydown', handleKeydown);
});
</script>

<style scoped>
.article-write-inspector-pane
 {
    position: fixed;
    z-index: var(--fsusblog-z-sticky, 30);
    top: var(--fsus-space-4);
    right: calc(
        var(--fsus-space-4) + var(--fsus-control-height-spacious) + var(--fsus-space-2)
    );
    bottom: var(--fsus-space-4);
    display: grid;
    box-sizing: border-box;
    width: min(32rem, 42vw);
    min-height: 0;
    grid-template-rows: auto minmax(0, 1fr);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-panel);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-primary);
}

.article-write-inspector-pane__header
 {
    display: flex;
    min-height: var(--fsus-control-height-spacious);
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--fsusblog-panel-border);
    padding-inline: var(--fsus-space-4) var(--fsus-space-2);
}

.article-write-inspector-pane__title
 {
    margin: 0;
    color: var(--fsusblog-text-primary);
    font-size: var(--fsus-typography-heading-sm-size);
    font-weight: 700;
    line-height: 1.35;
}

.article-write-inspector-pane__close
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

.article-write-inspector-pane__close:hover
 {
    background: var(--el-fill-color-light);
    color: var(--fsus-scholarly-blue);
}

.article-write-inspector-pane__close:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.article-write-inspector-launcher
 {
    position: absolute;
    z-index: var(--fsusblog-z-sticky, 30);
    top: calc((3.5rem - var(--fsus-control-height-spacious)) / 2);
    right: var(--fsus-space-4);
    display: inline-grid;
    width: var(--fsus-control-height-spacious);
    height: var(--fsus-control-height-spacious);
    cursor: pointer;
    place-items: center;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-page-bg);
    color: var(--fsus-scholarly-blue);
}

.article-write-inspector-launcher:hover
 {
    background: var(--el-fill-color-light);
}

.article-write-inspector-launcher:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.article-write-inspector-views,
.article-write-inspector-view
 {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-height: 0;
}

.article-write-inspector-view
 {
    overflow: auto;
    overscroll-behavior: contain;
}

@media (width <= 1023px)
 {
    .article-write-inspector-views
 {
        height: calc(100% - var(--fsus-control-height-spacious) - var(--fsus-space-2));
    }
}
</style>
