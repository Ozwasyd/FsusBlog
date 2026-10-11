<template>
    <AccountRouteFrame
        :area-label="workspaceContext.areaMeta.label"
        :nav-groups="navGroups"
        :content-classes="contentClasses"
        frame-class="admin-workspace-frame"
        :motion-policy="motionPolicy"
        :route-view-key="articleRouteViewKey"
    >
        <template #before-content="{ mobileNavigationActive }">
            <ArticleWorkspaceTabStrip v-if="isArticleWorkspaceRouteValue" />
            <div
                v-if="isArticleWorkspaceRouteValue"
                class="admin-workspace-library"
            >
                <ArticleLibraryRail
                    v-if="!mobileNavigationActive"
                    :presentation="libraryPresentation"
                    :active-group="libraryGroup"
                    :current-article-id="routeArticleIdentity?.articleId ?? null"
                    @group="selectLibraryGroup"
                    @page="forwardLibraryPage"
                    @open-article="openLibraryArticle"
                    @reveal-current="emit('revealCurrent', $event)"
                    @expanded="emit('expanded', $event)"
                />
                <p
                    v-if="libraryNavigationStatus"
                    role="status"
                >{{ libraryNavigationStatus }}</p>
            </div>
        </template>
    </AccountRouteFrame>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import type { ArticleLibraryGroup, ArticleLibraryPresentation } from '@/components/admin/article/articleLibraryPresentation';
import ArticleLibraryRail from '@/components/admin/article/ArticleLibraryRail.vue';
import ArticleWorkspaceTabStrip from '@/components/admin/article/ArticleWorkspaceTabStrip.vue';
import { useArticleWorkspaceTabs } from '@/composables/useArticleWorkspaceTabs';
import { getAccountNavGroups } from '@/layouts/accountNav';
import { resolveAccountPageKindClass } from '@/layouts/accountPageKind';
import AccountRouteFrame from '@/layouts/AccountRouteFrame.vue';
import { resolveAccountRouteMotionPolicy } from '@/layouts/accountRouteMotion';
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext';
import {
    isAccountContentMode,
    isAccountPageKind,
    type AccountContentMode,
    type AccountPageKind
} from '@/router/accountRouteMeta';
import {
    articleWorkspaceTabRouter,
    isArticleWorkspaceRoute,
    type ArticleWorkspaceRouteLocation,
    type ArticleWorkspaceTabPresentation,
    type ArticleWorkspaceRouterReceipt
} from '@/services/authoring/articleWorkspaceTabRouter';

const props = defineProps<{
    /** Only the shared query owner can supply an admitted display page. */
    libraryPresentation?: ArticleLibraryPresentation;
}>();
const emit = defineEmits<{
    group: [group: ArticleLibraryGroup];
    page: [group: ArticleLibraryGroup, direction: 'previous' | 'next'];
    openArticle: [articleId: number];
    revealCurrent: [articleId: number];
    expanded: [expanded: boolean];
    navigation: [receipt: ArticleWorkspaceRouterReceipt];
}>();
const route = useRoute();
const { tabs, activateTab } = useArticleWorkspaceTabs();
const libraryGroup = ref<ArticleLibraryGroup>('recent');
const libraryNavigationStatus = ref('');
const libraryPresentation = computed<ArticleLibraryPresentation>(() => props.libraryPresentation ?? {
    state: 'unconnected',
    group: libraryGroup.value
});
const articleWorkspaceRouteLocation = computed<ArticleWorkspaceRouteLocation>(() => ({
    name: typeof route.name === 'string' ? route.name : null,
    path: route.path,
    fullPath: route.fullPath
}));
const isArticleWorkspaceRouteValue = computed(() => isArticleWorkspaceRoute(articleWorkspaceRouteLocation.value));
const routeArticleId = computed<number | null>(() =>
{
    const raw = route.params.id;
    const value = Number(Array.isArray(raw) ? raw[0] : raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
});
// Registry publication, Rail state and URL query/hash changes cannot rekey the mounted editor.
const articleRouteViewKey = computed(() =>
{
    if (route.name === 'ManageWriteArticle')
    {
        return 'ManageWriteArticle';
    }
    return route.name === 'ManageEditArticle' && routeArticleId.value !== null
        ? `ManageEditArticle:${routeArticleId.value}`
        : undefined;
});
const workspaceContext = useAccountWorkspaceContext();
const navGroups = computed(() => getAccountNavGroups({
    ...workspaceContext.value,
    surface: 'manage'
}));
const pageKind = computed<AccountPageKind>(() =>
{
    if (!isAccountPageKind(route.meta.accountPageKind))
    {
        if (import.meta.env.DEV)
        {
            throw new Error(`Account route ${route.path} is missing a valid accountPageKind`);
        }
        return 'collection';
    }

    return route.meta.accountPageKind;
});
const contentMode = computed<AccountContentMode>(() => (
    isAccountContentMode(route.meta.accountContentMode)
        ? route.meta.accountContentMode
        : 'wide'
));
const pageKindClass = computed(() => resolveAccountPageKindClass('manage', pageKind.value));
const motionPolicy = computed(() => resolveAccountRouteMotionPolicy(
    'manage',
    pageKind.value,
    contentMode.value
));
const contentClasses = computed(() => [
    contentMode.value === 'takeover'
        ? 'account-frame-outlet--takeover'
        : 'account-frame-outlet--default',
    pageKindClass.value
]);

const routeArticleIdentity = computed<ArticleWorkspaceTabPresentation | null>(() =>
{
    if (!isArticleWorkspaceRouteValue.value)
    {
        return null;
    }

    const articleId = routeArticleId.value;
    if (articleId !== null)
    {
        return tabs.value.find((tab) => tab.articleId === articleId) ?? null;
    }

    const draftTabs = tabs.value.filter((tab) => tab.articleId === null);
    return draftTabs.length === 1 ? draftTabs[0] ?? null : null;
});

function selectLibraryGroup(group: ArticleLibraryGroup): void
{
    libraryGroup.value = group;
    libraryNavigationStatus.value = '';
    emit('group', group);
}

function forwardLibraryPage(group: ArticleLibraryGroup, direction: 'previous' | 'next'): void
{
    emit('page', group, direction);
}

async function openLibraryArticle(articleId: number): Promise<void>
{
    const tab = tabs.value.find((item) => item.articleId === articleId);
    if (!tab)
    {
        // The original document/session owner must supply the complete new-document open input.
        libraryNavigationStatus.value = '文章打开尚未接入文档会话';
        emit('openArticle', articleId);
        return;
    }
    try
    {
        const receipt = await activateTab(tab.tabId);
        libraryNavigationStatus.value = receipt.sessionState === 'blocked'
            || receipt.resultStatus === 'blocked' || receipt.resultStatus.startsWith('rejected')
            ? '文章导航暂不可用' : '';
        emit('navigation', receipt);
    }
    catch
    {
        libraryNavigationStatus.value = '文章导航暂不可用';
    }
}

watch(() => route.fullPath, () =>
{
    libraryNavigationStatus.value = '';
    if (!isArticleWorkspaceRouteValue.value)
    {
        return;
    }

    const tab = routeArticleIdentity.value;
    void articleWorkspaceTabRouter.syncRoute({
        route: articleWorkspaceRouteLocation.value,
        identity: tab
            ? {
                articleId: tab.articleId,
                draftId: tab.draftId,
                documentId: tab.documentId
            }
            : undefined
    });
}, { immediate: true });
</script>

<style scoped lang="scss">
.admin-workspace-library
{
    // The Rail panel is out of flow; expansion does not change the outlet's inline size.
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
}
</style>
