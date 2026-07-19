<template>
    <AccountRouteFrame
        :area-label="workspaceContext.areaMeta.label"
        :nav-groups="navGroups"
        :content-classes="contentClasses"
        frame-class="admin-workspace-frame"
        :motion-policy="motionPolicy"
    />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import AccountRouteFrame from '@/layouts/AccountRouteFrame.vue';
import { getAccountNavGroups } from '@/layouts/accountNav';
import { resolveAccountPageKindClass } from '@/layouts/accountPageKind';
import { resolveAccountRouteMotionPolicy } from '@/layouts/accountRouteMotion';
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext';
import {
    isAccountContentMode,
    isAccountPageKind,
    type AccountContentMode,
    type AccountPageKind
} from '@/router/accountRouteMeta';

const route = useRoute();
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
</script>
