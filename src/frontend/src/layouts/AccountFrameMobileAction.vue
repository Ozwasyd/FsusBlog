<template>
    <button
        type="button"
        class="account-mobile-drawer-trigger"
        :aria-label="`打开账户导航：${currentNavGroupLabel} / ${currentNavItem?.label ?? '当前页面'}`"
        aria-controls="account-mobile-drawer"
        :aria-expanded="mobileDrawerVisible"
        @click="mobileDrawerVisible = true"
    >
        <ElIcon
            :size="18"
            aria-hidden="true"
        ><Expand /></ElIcon>
    </button>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';

import { Expand } from '@/fsusui/icons';
import { useAccountFrameDrawerState } from '@/layouts/accountFrameContext';
import {
    getAccountNavGroups,
    isAccountNavGroupActive,
    isAccountNavItemActive
} from '@/layouts/accountNav';
import { useAccountWorkspaceContext } from '@/layouts/accountWorkspaceContext';

const route = useRoute();
const workspaceContext = useAccountWorkspaceContext();
const mobileDrawerVisible = useAccountFrameDrawerState();

const navGroups = computed(() => getAccountNavGroups(workspaceContext.value));
const currentNavGroup = computed(() => (
    [...navGroups.value].reverse().find((group) => isAccountNavGroupActive(group, route.path))
    ?? navGroups.value[0]
    ?? null
));
const currentNavGroupLabel = computed(() => (
    currentNavGroup.value?.label ?? workspaceContext.value.areaMeta.label
));
const currentNavItem = computed(() => (
    [...(currentNavGroup.value?.items ?? [])].reverse().find((item) => (
        isAccountNavItemActive(item, route.path)
    ))
));

watch(() => route.fullPath, () =>
{
    mobileDrawerVisible.value = false;
});
</script>
