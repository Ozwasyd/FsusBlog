<template>
    <AccountRouteFrame
        :area-label="workspaceContext.areaMeta.label"
        :nav-groups="navGroups"
        :content-classes="contentClasses"
        frame-class="admin-workspace-frame"
        :motion-policy="motionPolicy"
    >
        <template #before-content>
            <ArticleWorkspaceTabStrip v-if="isArticleWorkspaceRouteValue" />
        </template>
    </AccountRouteFrame>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';

import ArticleWorkspaceTabStrip from '@/components/admin/article/ArticleWorkspaceTabStrip.vue';
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
    type ArticleWorkspaceTabPresentation
} from '@/services/authoring/articleWorkspaceTabRouter';

const route = useRoute();
const articleWorkspaceRouteLocation = computed<ArticleWorkspaceRouteLocation>(() => ({
    name: typeof route.name === 'string' ? route.name : null,
    path: route.path,
    fullPath: route.fullPath
}));
const isArticleWorkspaceRouteValue = computed(() => isArticleWorkspaceRoute(articleWorkspaceRouteLocation.value));
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

    const rawArticleId = route.params.id;
    const articleId = Number(Array.isArray(rawArticleId) ? rawArticleId[0] : rawArticleId);
    if (Number.isSafeInteger(articleId) && articleId > 0)
    {
        return articleWorkspaceTabRouter.listTabs().find((tab) => tab.articleId === articleId) ?? null;
    }

    const draftTabs = articleWorkspaceTabRouter.listTabs().filter((tab) => tab.articleId === null);
    return draftTabs.length === 1 ? draftTabs[0] ?? null : null;
});

watch(() => route.fullPath, () =>
{
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
