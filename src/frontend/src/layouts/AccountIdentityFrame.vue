<template>
    <AccountRouteFrame
        :area-label="workspaceContext.areaMeta.label"
        :nav-groups="navGroups"
        :content-classes="contentClasses"
    />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import AccountRouteFrame from '@/layouts/AccountRouteFrame.vue';
import { getAccountNavGroups } from '@/layouts/accountNav';
import { resolveAccountPageKindClass } from '@/layouts/accountPageKind';
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext';
import { isAccountPageKind } from '@/router/accountRouteMeta';

const route = useRoute();
const workspaceContext = useAccountWorkspaceContext();
const navGroups = computed(() => getAccountNavGroups({
    ...workspaceContext.value,
    surface: 'self'
}));
const pageKindClass = computed(() =>
{
    if (!isAccountPageKind(route.meta.accountPageKind))
    {
        if (import.meta.env.DEV)
        {
            throw new Error(`Account route ${route.path} is missing a valid accountPageKind`);
        }
        return '';
    }

    return resolveAccountPageKindClass('self', route.meta.accountPageKind);
});
const contentClasses = computed(() => [
    route.meta.accountContentMode === 'takeover'
        ? 'max-w-none'
        : 'max-w-[var(--fsusblog-container-account)]',
    route.meta.accountContentMode === 'takeover'
        ? 'flex min-h-[calc(100dvh-9rem)] min-w-0 flex-col lg:min-h-[calc(100dvh-8rem)]'
        : 'min-w-0',
    pageKindClass.value
]);
</script>
