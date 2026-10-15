<template>
    <nav
        v-if="!isCompact && tabs.length > 0"
        class="article-workspace-tabs"
        aria-label="文章标签"
        data-article-workspace-tab-strip="desktop"
    >
        <div
            ref="tabListRef"
            class="article-workspace-tabs__list"
            role="tablist"
            aria-orientation="horizontal"
            @keydown="handleTabListKeydown"
        >
            <div
                v-for="tab in visibleTabs"
                :key="tab.tabId"
                class="article-workspace-tabs__item"
                :class="{ 'article-workspace-tabs__item--active': tab.isActive }"
                :data-tab-state="tabState(tab)"
            >
                <FsusUiButton
                    :id="tabButtonId(tab.tabId)"
                    :ref="(element) => registerTabElement(tab.tabId, element)"
                    native-type="button"
                    text
                    :auto-insert-space="false"
                    class="article-workspace-tabs__tab"
                    role="tab"
                    :aria-selected="tab.isActive"
                    :aria-controls="`article-workspace-panel-${tab.tabId}`"
                    :tabindex="tab.isActive ? 0 : -1"
                    :aria-label="tabAccessibleLabel(tab)"
                    @click="activate(tab.tabId)"
                    @dblclick="promote(tab.tabId)"
                    @auxclick="handleAuxiliaryClick(tab.tabId, $event)"
                >
                    <span class="article-workspace-tabs__tab-content">
                        <span class="article-workspace-tabs__title">{{ tab.title }}</span>
                        <span class="article-workspace-tabs__state">
                            <span class="sr-only">状态：</span>{{ tabState(tab) }}
                        </span>
                    </span>
                </FsusUiButton>
                <FsusUiButton
                    native-type="button"
                    text
                    :auto-insert-space="false"
                    class="article-workspace-tabs__pin"
                    :aria-label="tab.isPinned ? `取消固定：${tab.title}` : `固定：${tab.title}`"
                    :aria-pressed="tab.isPinned"
                    @click="promoteOrUnpin(tab)"
                >
                    <span aria-hidden="true">{{ tab.isPinned ? '已固定' : '预览' }}</span>
                </FsusUiButton>
                <FsusUiButton
                    native-type="button"
                    text
                    :auto-insert-space="false"
                    class="article-workspace-tabs__close"
                    :aria-label="`请求关闭：${tab.title}`"
                    @click="requestClose(tab.tabId)"
                >
                    <span aria-hidden="true">×</span>
                </FsusUiButton>
            </div>
        </div>

        <FsusUiButton
            v-if="tabs.length > 1"
            ref="overflowTriggerRef"
            native-type="button"
            text
            :auto-insert-space="false"
            class="article-workspace-tabs__overflow"
            :aria-expanded="overflowOpen"
            aria-haspopup="menu"
            @click="overflowOpen = !overflowOpen"
        >
            更多标签（{{ tabs.length }}）
        </FsusUiButton>
        <div
            v-if="overflowOpen"
            class="article-workspace-tabs__overflow-list"
            role="menu"
            aria-label="所有文章标签"
            @keydown="handleMenuKeydown"
        >
            <div
                v-for="tab in tabs"
                :key="`overflow-${tab.tabId}`"
                class="article-workspace-tabs__overflow-item"
                role="none"
            >
                <FsusUiButton
                    native-type="button"
                    text
                    :auto-insert-space="false"
                    class="article-workspace-tabs__overflow-tab"
                    role="menuitem"
                    @click="activateFromOverflow(tab.tabId)"
                >
                    <span class="article-workspace-tabs__menu-content">
                        <span class="article-workspace-tabs__menu-title">{{ tab.title }}</span>
                        <span class="article-workspace-tabs__overflow-state">{{ tabState(tab) }}</span>
                    </span>
                </FsusUiButton>
                <FsusUiButton
                    native-type="button"
                    text
                    :auto-insert-space="false"
                    class="article-workspace-tabs__overflow-close"
                    role="menuitem"
                    :aria-label="`请求关闭：${tab.title}`"
                    @click="requestClose(tab.tabId)"
                >
                    关闭
                </FsusUiButton>
            </div>
        </div>
    </nav>

    <section
        v-else-if="isCompact && tabs.length > 0"
        class="article-workspace-tabs article-workspace-tabs--compact"
        aria-label="当前文章标签"
        data-article-workspace-tab-strip="mobile"
    >
        <FsusUiButton
            native-type="button"
            text
            :auto-insert-space="false"
            class="article-workspace-tabs__compact-trigger"
            ref="overflowTriggerRef"
            :aria-expanded="overflowOpen"
            aria-haspopup="menu"
            @click="overflowOpen = !overflowOpen"
        >
            <span class="article-workspace-tabs__compact-content">
                <span class="article-workspace-tabs__compact-title">
                    {{ activeTab?.title ?? '没有打开的文章' }}
                </span>
                <span class="article-workspace-tabs__compact-state">
                    {{ activeTab ? tabState(activeTab) : '选择文章' }}
                </span>
            </span>
        </FsusUiButton>
        <div
            v-if="overflowOpen"
            class="article-workspace-tabs__compact-list"
            role="menu"
            aria-label="切换文章"
            @keydown="handleMenuKeydown"
        >
            <div
                v-for="tab in tabs"
                :key="`compact-${tab.tabId}`"
                class="article-workspace-tabs__compact-item"
                role="none"
            >
                <FsusUiButton
                    native-type="button"
                    text
                    :auto-insert-space="false"
                    class="article-workspace-tabs__compact-tab"
                    role="menuitemradio"
                    :aria-checked="tab.isActive"
                    @click="activateFromOverflow(tab.tabId)"
                >
                    <span class="article-workspace-tabs__menu-content">
                        <span class="article-workspace-tabs__menu-title">{{ tab.title }}</span>
                        <span class="article-workspace-tabs__compact-status">{{ tabState(tab) }}</span>
                    </span>
                </FsusUiButton>
                <FsusUiButton
                    native-type="button"
                    text
                    :auto-insert-space="false"
                    class="article-workspace-tabs__compact-action"
                    role="menuitem"
                    :aria-label="tab.isPinned ? `取消固定：${tab.title}` : `固定：${tab.title}`"
                    @click="promoteOrUnpin(tab)"
                >
                    {{ tab.isPinned ? '取消固定' : '固定' }}
                </FsusUiButton>
                <FsusUiButton
                    native-type="button"
                    text
                    :auto-insert-space="false"
                    class="article-workspace-tabs__compact-action"
                    role="menuitem"
                    :aria-label="`请求关闭：${tab.title}`"
                    @click="requestClose(tab.tabId)"
                >
                    关闭
                </FsusUiButton>
            </div>
        </div>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRaw } from 'vue';

import { useArticleWorkspaceTabs } from '@/composables/useArticleWorkspaceTabs';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { FsusUiButton } from '@/fsusui/button';
import type {
    ArticleWorkspaceTabPresentation,
    ArticleWorkspaceTabRouter,
    ArticleWorkspaceNavigationPort
} from '@/services/authoring/articleWorkspaceTabRouter';

import type { ComponentPublicInstance } from 'vue';

defineOptions({ name: 'ArticleWorkspaceTabStrip' });

/** Only ButtonInstance's documented native ref is needed by the existing focus paths. */
interface WorkspaceButtonHandle {
    readonly ref?: HTMLButtonElement;
}

const props = defineProps<{
    coordinator?: ArticleWorkspaceTabRouter;
    router?: ArticleWorkspaceNavigationPort;
}>();

const isCompact = useMediaQuery('(max-width: 1023px)', false);
const overflowOpen = ref(false);
const tabListRef = ref<HTMLElement | null>(null);
const overflowTriggerRef = ref<WorkspaceButtonHandle | null>(null);
const tabElements = new Map<string, HTMLElement>();
const {
    tabs,
    activeTab,
    activateTab,
    promotePreview,
    unpinTab,
    requestClose: requestTabClose
} = useArticleWorkspaceTabs({
    coordinator: props.coordinator ? toRaw(props.coordinator) : undefined,
    router: props.router ? toRaw(props.router) : undefined
});
const visibleTabs = computed(() =>
{
    const allTabs = tabs.value;
    const limit = 24;
    if (allTabs.length <= limit)
    {
        return allTabs;
    }

    const activeIndex = Math.max(0, allTabs.findIndex((tab) => tab.isActive));
    const start = Math.min(
        Math.max(0, activeIndex - Math.floor(limit / 2)),
        allTabs.length - limit
    );
    return allTabs.slice(start, start + limit);
});

const tabButtonId = (tabId: string): string => `article-workspace-tab-${tabId}`;

const registerTabElement = (tabId: string, element: Element | ComponentPublicInstance | null): void =>
{
    const buttonElement = (element as WorkspaceButtonHandle | null)?.ref;
    if (buttonElement instanceof HTMLElement)
    {
        tabElements.set(tabId, buttonElement);
        return;
    }
    tabElements.delete(tabId);
};

const tabState = (tab: ArticleWorkspaceTabPresentation): string =>
{
    if (tab.sessionState === 'blocked')
    {
        return '不可用';
    }
    if (tab.status.lifecycle === 'deleted')
    {
        return '已删除';
    }
    if (tab.status.lifecycle === 'archived')
    {
        return '已归档';
    }
    if (tab.status.lifecycle === 'draft-replaced')
    {
        return '已替换';
    }
    if (tab.status.permission !== 'allowed' || tab.status.lifecycle !== 'current')
    {
        return '受限';
    }
    if (tab.status.conflict)
    {
        return '冲突';
    }
    if (tab.status.recovery)
    {
        return '待恢复';
    }
    if (tab.status.saving)
    {
        return '保存中';
    }
    if (tab.status.dirty || tab.status.pendingAttachments)
    {
        return '未同步';
    }
    return tab.isPreview ? '预览' : '已固定';
};

const tabAccessibleLabel = (tab: ArticleWorkspaceTabPresentation): string =>
    `${tab.title}，${tabState(tab)}${tab.isActive ? '，当前' : ''}`;

const activate = async (tabId: string): Promise<void> =>
{
    const receipt = await activateTab(tabId);
    if (receipt.sessionState === 'blocked')
    {
        overflowOpen.value = false;
        return;
    }
    await nextTick();
    const tabElement = tabElements.get(tabId);
    tabElement?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    tabElement?.focus();
    if (!tabElement)
    {
        overflowTriggerRef.value?.ref?.focus();
    }
    overflowOpen.value = false;
};

const promote = async (tabId: string): Promise<void> =>
{
    await promotePreview(tabId);
};

const promoteOrUnpin = async (tab: ArticleWorkspaceTabPresentation): Promise<void> =>
{
    if (tab.isPinned)
    {
        await unpinTab(tab.tabId);
        return;
    }
    await promote(tab.tabId);
};

const requestClose = (tabId: string): void =>
{
    requestTabClose(tabId);
};

const activateFromOverflow = async (tabId: string): Promise<void> =>
{
    await activate(tabId);
};

const closeOverflowAndReturnFocus = (): void =>
{
    overflowOpen.value = false;
    overflowTriggerRef.value?.ref?.focus();
};

const handleMenuKeydown = (event: KeyboardEvent): void =>
{
    if (event.key === 'Escape')
    {
        event.preventDefault();
        closeOverflowAndReturnFocus();
        return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
    {
        return;
    }

    const menu = event.currentTarget as HTMLElement | null;
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ?? [])];
    if (items.length === 0)
    {
        return;
    }

    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const startIndex = currentIndex >= 0
        ? currentIndex
        : event.key === 'ArrowUp'
            ? 0
            : -1;
    const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
            ? items.length - 1
            : event.key === 'ArrowDown'
                ? (startIndex + 1) % items.length
                : (startIndex - 1 + items.length) % items.length;
    event.preventDefault();
    items[nextIndex]?.focus();
};

const handleAuxiliaryClick = (tabId: string, event: MouseEvent): void =>
{
    if (event.button !== 1)
    {
        return;
    }
    event.preventDefault();
    requestClose(tabId);
};

const handleTabListKeydown = (event: KeyboardEvent): void =>
{
    const buttons = [...(tabListRef.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const renderedTabs = visibleTabs.value;
    if (buttons.length === 0)
    {
        return;
    }
    const currentIndex = buttons.findIndex((button) => button === document.activeElement);
    const activeIndex = currentIndex >= 0
        ? currentIndex
        : Math.max(0, renderedTabs.findIndex((tab) => tab.isActive));
    let nextIndex = activeIndex;
    if (event.key === 'ArrowRight')
    {
        nextIndex = (activeIndex + 1) % buttons.length;
    }
    else if (event.key === 'ArrowLeft')
    {
        nextIndex = (activeIndex - 1 + buttons.length) % buttons.length;
    }
    else if (event.key === 'Home')
    {
        nextIndex = 0;
    }
    else if (event.key === 'End')
    {
        nextIndex = buttons.length - 1;
    }
    else if (event.key === 'Enter' || event.key === ' ')
    {
        const tab = renderedTabs[activeIndex];
        if (tab)
        {
            event.preventDefault();
            void activate(tab.tabId);
        }
        return;
    }
    else
    {
        return;
    }

    event.preventDefault();
    buttons[nextIndex]?.focus();
    const tab = renderedTabs[nextIndex];
    if (tab)
    {
        void activate(tab.tabId);
    }
};
</script>

<style scoped>
.article-workspace-tabs
 {
    position: relative;
    z-index: 1;
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--fsus-space-2);
    margin-bottom: var(--fsus-space-4);
    border-bottom: 1px solid var(--fsusblog-panel-border);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-primary);
}

.article-workspace-tabs__list
 {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    align-items: stretch;
    gap: var(--fsus-space-1);
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scrollbar-width: thin;
}

.article-workspace-tabs__item
 {
    display: flex;
    min-width: 9rem;
    max-width: 18rem;
    flex: 0 1 15rem;
    align-items: stretch;
    border-bottom: 2px solid transparent;
}

.article-workspace-tabs__item--active
 {
    border-bottom-color: var(--fsus-scholarly-blue);
}

.article-workspace-tabs__tab,
.article-workspace-tabs__pin,
.article-workspace-tabs__close,
.article-workspace-tabs__overflow,
.article-workspace-tabs__overflow-tab,
.article-workspace-tabs__overflow-close,
.article-workspace-tabs__compact-trigger,
.article-workspace-tabs__compact-tab,
.article-workspace-tabs__compact-action
 {
    min-height: var(--fsus-control-height-compact);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
}

.article-workspace-tabs__tab
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    flex: 1 1 auto;
    padding: var(--fsus-space-2) var(--fsus-space-3);
    text-align: left;
}

.article-workspace-tabs__tab-content,
.article-workspace-tabs__menu-content,
.article-workspace-tabs__compact-content
 {
    display: flex;
    width: 100%;
    min-width: 0;
    flex: 1 1 auto;
    align-items: center;
}

.article-workspace-tabs__tab-content
 {
    gap: var(--fsus-space-2);
}

.article-workspace-tabs__menu-content,
.article-workspace-tabs__compact-content
 {
    justify-content: space-between;
    gap: var(--fsus-space-3);
}

.article-workspace-tabs__title
 {
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.article-workspace-tabs__state,
.article-workspace-tabs__overflow-state,
.article-workspace-tabs__compact-state,
.article-workspace-tabs__compact-status
 {
    flex: 0 0 auto;
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    line-height: 1.35;
    white-space: nowrap;
}

.article-workspace-tabs__state
 {
    max-width: 5rem;
    overflow: hidden;
    text-overflow: ellipsis;
}

.article-workspace-tabs__pin,
.article-workspace-tabs__close
 {
    min-width: var(--fsus-icon-target-small);
    padding-inline: var(--fsus-space-1);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
}

.article-workspace-tabs__close
 {
    font-size: 18px;
}

.article-workspace-tabs__item > .article-workspace-tabs__pin,
.article-workspace-tabs__item > .article-workspace-tabs__close,
.article-workspace-tabs__overflow-item > .article-workspace-tabs__overflow-close,
.article-workspace-tabs__compact-item > .article-workspace-tabs__compact-action
 {
    margin-left: 0;
}

.article-workspace-tabs__tab:hover,
.article-workspace-tabs__tab:focus-visible,
.article-workspace-tabs__pin:hover,
.article-workspace-tabs__pin:focus-visible,
.article-workspace-tabs__close:hover,
.article-workspace-tabs__close:focus-visible,
.article-workspace-tabs__overflow:hover,
.article-workspace-tabs__overflow:focus-visible,
.article-workspace-tabs__overflow-tab:hover,
.article-workspace-tabs__overflow-tab:focus-visible,
.article-workspace-tabs__overflow-close:hover,
.article-workspace-tabs__overflow-close:focus-visible,
.article-workspace-tabs__compact-trigger:hover,
.article-workspace-tabs__compact-trigger:focus-visible,
.article-workspace-tabs__compact-tab:hover,
.article-workspace-tabs__compact-tab:focus-visible,
.article-workspace-tabs__compact-action:hover,
.article-workspace-tabs__compact-action:focus-visible
 {
    color: var(--fsusblog-text-primary);
    outline: 2px solid var(--fsus-color-focus-ring, var(--fsus-scholarly-blue));
    outline-offset: -2px;
}

.article-workspace-tabs__overflow
 {
    flex: 0 0 auto;
    padding-inline: var(--fsus-space-3);
    color: var(--fsusblog-text-secondary);
    font-size: 12px;
    white-space: nowrap;
}

.article-workspace-tabs__overflow-list
 {
    position: absolute;
    top: calc(100% + var(--fsus-space-1));
    right: 0;
    z-index: 2;
    display: grid;
    width: min(28rem, 92vw);
    max-height: min(60vh, 24rem);
    overflow: auto;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-popover);
    background: var(--fsusblog-page-bg);
    box-shadow: var(--fsus-shadow-popover, none);
}

.article-workspace-tabs__overflow-item,
.article-workspace-tabs__compact-item
 {
    display: flex;
    min-width: 0;
    align-items: center;
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.article-workspace-tabs__overflow-item:last-child,
.article-workspace-tabs__compact-item:last-child
 {
    border-bottom: 0;
}

.article-workspace-tabs__overflow-tab,
.article-workspace-tabs__compact-tab
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    flex: 1 1 auto;
    padding: var(--fsus-space-3) var(--fsus-space-4);
    text-align: left;
}

.article-workspace-tabs__menu-title
 {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.article-workspace-tabs__overflow-close
 {
    flex: 0 0 auto;
    padding-inline: var(--fsus-space-3);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
}

.article-workspace-tabs--compact
 {
    display: block;
    border-bottom: 0;
}

.article-workspace-tabs__compact-trigger
 {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-navigation);
    padding: var(--fsus-space-2) var(--fsus-space-3);
    text-align: left;
}

.article-workspace-tabs__compact-title
 {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    font-size: 14px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.article-workspace-tabs__compact-list
 {
    display: grid;
    max-height: min(60vh, 24rem);
    margin-top: var(--fsus-space-1);
    overflow: auto;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-popover);
    background: var(--fsusblog-page-bg);
}

.article-workspace-tabs__compact-action
 {
    flex: 0 0 auto;
    padding-inline: var(--fsus-space-2);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
}

@media (width <= 1023px)
 {
    .article-workspace-tabs
 {
        margin-bottom: var(--fsus-space-3);
    }
}

@media (prefers-reduced-motion: reduce)
 {
    .article-workspace-tabs__list
 {
        scroll-behavior: auto;
    }
}

@media (forced-colors: active)
 {
    .article-workspace-tabs__tab:focus-visible,
    .article-workspace-tabs__pin:focus-visible,
    .article-workspace-tabs__close:focus-visible,
    .article-workspace-tabs__overflow:focus-visible,
    .article-workspace-tabs__overflow-tab:focus-visible,
    .article-workspace-tabs__overflow-close:focus-visible,
    .article-workspace-tabs__compact-trigger:focus-visible,
    .article-workspace-tabs__compact-tab:focus-visible,
    .article-workspace-tabs__compact-action:focus-visible
 {
        outline: 2px solid Highlight;
    }
}
</style>
