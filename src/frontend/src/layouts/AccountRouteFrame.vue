<template>
    <ElDrawer
        id="account-mobile-drawer"
        v-model="mobileDrawerVisible"
        :title="mobileDrawerTitle"
        direction="ltr"
        size="min(86vw, 22rem)"
        class="account-mobile-drawer"
        :motion="fsusBlogMotionPresets.mobileDrawer"
    >
        <AccountNavigationPanel
            class="account-mobile-drawer-nav"
            :area-label="areaLabel"
            :groups="navGroups"
            variant="mobile"
            @navigate="closeMobileDrawer"
        />
    </ElDrawer>

    <div class="mx-auto flex w-full max-w-[var(--fsusblog-container-workbench)] flex-1 gap-5 px-4 py-5 sm:px-6 sm:py-8 lg:gap-10 lg:px-10">
        <aside class="hidden lg:block lg:w-[18rem] lg:shrink-0">
            <AccountNavigationPanel
                class="account-sidebar-frame sticky top-24 pr-6"
                :area-label="areaLabel"
                :groups="navGroups"
                heading-id="account-shell-area-title"
                variant="desktop"
            />
        </aside>

        <main
            id="account-main"
            tabindex="-1"
            class="account-main-scroll min-w-0 flex-1 outline-none"
            aria-labelledby="account-shell-area-title"
        >
            <RouterView v-slot="{ Component }">
                <FsuTransition :name="fsusBlogMotionPresets.route" mode="out-in" :duration="220">
                    <component
                        :is="Component"
                        :key="accountRouteViewKey"
                        class="mx-auto w-full min-w-0"
                        :class="contentClasses"
                    />
                </FsuTransition>
            </RouterView>
        </main>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import AccountNavigationPanel from '@/components/account/AccountNavigationPanel.vue';
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion';
import { FsuTransition } from '@/fsusui/motion';
import { useAccountFrameDrawerState } from '@/layouts/accountFrameContext';
import {
    isAccountNavGroupActive,
    type AccountNavGroup
} from '@/layouts/accountNav';

const props = defineProps<{
    areaLabel: string;
    navGroups: readonly AccountNavGroup[];
    contentClasses: readonly string[];
}>();

const route = useRoute();
const mobileDrawerVisible = useAccountFrameDrawerState();
const currentNavGroup = computed(() => (
    [...props.navGroups].reverse().find((group) => isAccountNavGroupActive(group, route.path))
    ?? props.navGroups[0]
    ?? null
));
const mobileDrawerTitle = computed(() => (
    `${props.areaLabel}导航 · ${currentNavGroup.value?.label ?? props.areaLabel}`
));
const accountRouteViewKey = computed(() =>
{
    const accountRootIndex = route.matched.findIndex((record) => record.path === '/user');
    const accountViewRecord = accountRootIndex >= 0
        ? route.matched[accountRootIndex + 2]
        : undefined;
    const routeName = typeof accountViewRecord?.name === 'string'
        ? accountViewRecord.name
        : accountViewRecord?.path ?? route.path;
    const id = route.params.id;
    if (Array.isArray(id))
    {
        return `${routeName}:${id.join('/')}`;
    }

    return typeof id === 'string' && id.length > 0
        ? `${routeName}:${id}`
        : routeName;
});

const closeMobileDrawer = (): void =>
{
    mobileDrawerVisible.value = false;
};

</script>
