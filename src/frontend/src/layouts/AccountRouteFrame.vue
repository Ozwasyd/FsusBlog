<template>
    <ElDrawer
        id="account-mobile-drawer"
        v-model="mobileDrawerVisible"
        :title="mobileDrawerTitle"
        direction="ltr"
        size="min(86vw, 22rem)"
        class="account-mobile-drawer"
        :motion="fsusBlogMotionPresets.mobileDrawer"
        @open="mobileNavigationTransitionActive = true"
        @closed="mobileNavigationTransitionActive = false"
    >
        <template #header="{ titleId, titleClass }">
            <span
                :id="titleId"
                role="heading"
                aria-level="2"
                :class="[titleClass, 'account-mobile-drawer__title']"
            >
                {{ mobileDrawerTitle }}
            </span>
        </template>

        <AccountNavigationPanel
            class="account-mobile-drawer-nav"
            :area-label="areaLabel"
            :groups="navGroups"
            variant="mobile"
            @navigate="closeMobileDrawer"
        />
    </ElDrawer>

    <div
        class="account-route-frame"
        :class="frameClass"
    >
        <aside class="account-route-frame__sidebar">
            <AccountNavigationPanel
                class="account-sidebar-frame sticky top-24 pr-6"
                :area-label="areaLabel"
                :groups="navGroups"
                heading-id="account-shell-area-title"
                variant="desktop"
            />
        </aside>

        <main
            ref="accountMain"
            id="account-main"
            tabindex="-1"
            class="account-main-scroll"
            aria-labelledby="account-shell-area-title"
        >
            <slot
                name="before-content"
                :mobile-navigation-active="mobileDrawerVisible || mobileNavigationTransitionActive"
            />
            <RouterView
                v-if="routeOutletEnabled !== false"
                v-slot="{ Component }"
            >
                <FsuTransition
                    :name="motionPolicy.preset ?? fsusBlogMotionPresets.route"
                    :disabled="motionPolicy.preset === null || !motionEnabled"
                >
                    <component
                        :is="Component"
                        :ref="captureRouteOutlet"
                        :key="accountRouteViewKey"
                        class="account-frame-outlet"
                        :class="contentClasses"
                    />
                </FsuTransition>
            </RouterView>
        </main>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import AccountNavigationPanel from '@/components/account/AccountNavigationPanel.vue';
import { useMotionPreference } from '@/composables/useMotionPreference';
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion';
import { FsusUiDrawer as ElDrawer } from '@/fsusui/drawer';
import { FsuTransition } from '@/fsusui/motion';
import { useAccountFrameDrawerState } from '@/layouts/accountFrameContext';
import {
    isAccountNavGroupActive,
    type AccountNavGroup
} from '@/layouts/accountNav';
import {
    shouldRestoreAccountRouteFocus,
    type AccountRouteMotionPolicy
} from '@/layouts/accountRouteMotion';

const props = withDefaults(defineProps<{
    areaLabel: string;
    navGroups: readonly AccountNavGroup[];
    contentClasses: readonly string[];
    frameClass: string;
    motionPolicy: AccountRouteMotionPolicy;
    /** Optional route-owned key; this frame keeps its original key policy for other consumers. */
    routeViewKey?: string;
    /** An explicit restore may defer the article outlet; other consumers retain their existing behavior. */
    routeOutletEnabled?: boolean;
}>(), {
    routeOutletEnabled: true
});
const emit = defineEmits<{
    routeOutlet: [instance: unknown];
}>();
function captureRouteOutlet(instance: unknown): void
{
    // Vue's actual public routed-component ref, including null on release.
    emit('routeOutlet', instance);
}

const route = useRoute();
const accountMain = ref<HTMLElement | null>(null);
const { motionEnabled } = useMotionPreference();
const mobileDrawerVisible = useAccountFrameDrawerState();
// Observe actual public transition events; a same-flush true/false request need not open a Drawer.
const mobileNavigationTransitionActive = ref(false);
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
    if (props.routeViewKey !== undefined)
    {
        return props.routeViewKey;
    }
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

watch(() => route.fullPath, async () =>
{
    if (typeof document === 'undefined')
    {
        return;
    }

    const activeElement = document.activeElement;
    const restoreFocus = shouldRestoreAccountRouteFocus(activeElement, accountMain.value);
    await nextTick();

    if (restoreFocus)
    {
        accountMain.value?.focus({ preventScroll: true });
    }
}, { flush: 'pre' });

const closeMobileDrawer = (): void =>
{
    mobileDrawerVisible.value = false;
};

</script>
