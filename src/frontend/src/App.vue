<template>
    <ElConfigProvider
        :theme-mode="mode"
        :render-pipeline="FSUSBLOG_RENDER_PIPELINE_CONFIG"
    >
        <RouterView
            v-if="isPublicShellRoute"
            v-slot="{ Component }"
        >
            <Transition
                mode="out-in"
                :css="false"
                @enter="runAppRouteEnter"
                @leave="runAppRouteLeave"
            >
                <component
                    :is="Component"
                    :key="route.fullPath"
                />
            </Transition>
        </RouterView>
        <div
            v-else
            class="app-wrapper w-full min-h-screen flex flex-col overflow-x-hidden"
        >
            <FsuTransition :name="fsusBlogMotionPresets.banner">
                <div
                    v-if="userStore.isAuthChecked && userStore.isLoggedIn && userStore.isBanned"
                    class="banned-user-banner w-full py-2 px-6 flex items-center justify-center gap-6 z-200 relative"
                >
                    <span class="text-[10px] font-bold tracking-normal uppercase">
                        当前账号处于管控状态：{{ userStore.userInfo?.banReason || '仅限阅读模式' }}
                    </span>
                    <RouterLink
                        to="/user/messagebox"
                        class="text-[9px] underline underline-offset-4 opacity-70 hover:opacity-100 transition-opacity uppercase font-bold tracking-normal"
                    >
                        查看详情
                    </RouterLink>
                </div>
            </FsuTransition>

            <RouterView v-slot="{ Component }">
                <Transition
                    mode="out-in"
                    :css="false"
                    @enter="runAppRouteEnter"
                    @leave="runAppRouteLeave"
                >
                    <component
                        v-if="showAppRoute"
                        :is="Component"
                        :key="privateRouteViewKey"
                    />
                </Transition>
            </RouterView>
        </div>
        <SecurityChallengeDialogHost />
    </ElConfigProvider>
</template>

<script setup lang="ts">
import {
    FsuTransition,
    runMotion,
    useMotionRouteCleanup,
    type MotionPhase
} from '@ozwasyd/element-plus/motion';
import { useHead } from '@unhead/vue';
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';

import { ADMIN_LOGOUT_EVENT, createAdminLogoutNavigationHandler } from '@/bootstrap/adminLogoutBridge';
import { runtimeActive } from '@/bootstrap/runtimeActivation';
import { createSessionExpiredNavigationHandler, SESSION_EXPIRED_EVENT } from '@/bootstrap/sessionExpiryBridge';
import SecurityChallengeDialogHost from '@/components/security/SecurityChallengeDialogHost.vue';
import { getRiskChallengeCoordinator } from '@/composables/useRiskChallengeCommand';
import { syncStaticDocumentTitleOnLocaleChange, useSessionBootstrap } from '@/composables/useSessionBootstrap';
import { useWindowEvents } from '@/composables/useWindowEvents';
import { fsusBlogMotionPresets } from '@/fsusui/blogMotion';
import { FSUSBLOG_RENDER_PIPELINE_CONFIG } from '@/fsusui/renderPipeline';
import { isPublicShellRouteName } from '@/public-renderers/publicPageModel';
import { privateSurfaceRuntime, type PrivateSurfaceTransition } from '@/services/privateSurfaceRuntime';
import { useThemeRuntime } from '@/services/themeRuntime';


const router = useRouter();
const route = useRoute();
const { userStore, siteStore, syncAuthPhase, syncDocumentTitle } = useSessionBootstrap();
const { mode } = useThemeRuntime();
const routeCleanup = useMotionRouteCleanup();
const securityChallengeCoordinator = getRiskChallengeCoordinator();
const cleanupByElement = new WeakMap<HTMLElement, () => boolean>();
const headConfig = computed(() => ({
    titleTemplate: isPublicShellRouteName(route.name) ? undefined : (titleChunk: string | undefined) =>
    {
        const siteTitle = siteStore.siteInfo.title;
        return titleChunk ? `${titleChunk} - ${siteTitle}` : siteTitle;
    },
    meta: isPublicShellRouteName(route.name)
        ? []
        : [{ name: 'description', content: siteStore.siteInfo.description }]
}));

useHead(headConfig);

const isPublicShellRoute = computed(() => isPublicShellRouteName(route.name));
const appRouteViewKey = computed(() =>
{
    if (route.path.startsWith('/user'))
    {
        return '/user';
    }

    return route.fullPath;
});
const isPrivateSurfaceRoute = computed(() => route.matched.some(record =>
    record.meta.requiresAccountSession === true
    || record.meta.requiresAdminSession === true
    || record.meta.requiresConfirmedIdentity === true
    || record.meta.requiresAuth === true
));
const privateRouteViewKey = computed(() => isPrivateSurfaceRoute.value
    ? `${appRouteViewKey.value}:${privateSurfaceRuntime.authGeneration.value}`
    : appRouteViewKey.value);
const showAppRoute = computed(() => !isPrivateSurfaceRoute.value || !privateSurfaceRuntime.isClearing.value);

privateSurfaceRuntime.setNavigationHandler(async (reason: PrivateSurfaceTransition) =>
{
    if (reason === 'admin-logout')
    {
        await router.replace(userStore.isLoggedIn ? '/user/identity' : '/');
        return;
    }

    if (reason === 'session-expired')
    {
        await router.replace('/login');
        return;
    }

    await router.replace('/');
});

const handleSessionExpired = createSessionExpiredNavigationHandler(router, () => userStore.isLoggedIn);
const handleAdminLogout = createAdminLogoutNavigationHandler(router, () => userStore.isLoggedIn);

function shouldHandleSpaAnchor(anchor: HTMLAnchorElement): boolean
{
    if (!runtimeActive.value || !isPublicShellRoute.value)
    {
        return false;
    }

    if (anchor.target && anchor.target !== '_self')
    {
        return false;
    }

    if (anchor.hasAttribute('download'))
    {
        return false;
    }

    const rawHref = anchor.getAttribute('href');
    if (!rawHref || rawHref.startsWith('#'))
    {
        return false;
    }

    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin)
    {
        return false;
    }

    if (url.pathname.startsWith('/api/'))
    {
        return false;
    }

    const resolved = router.resolve(`${url.pathname}${url.search}${url.hash}`);
    return isPublicShellRouteName(resolved.name);
}

const onDocumentClick = (event: MouseEvent): void =>
{
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    {
        return;
    }

    const target = event.target;
    if (!(target instanceof Element))
    {
        return;
    }

    const anchor = target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement) || !shouldHandleSpaAnchor(anchor))
    {
        return;
    }

    const url = new URL(anchor.href, window.location.origin);
    event.preventDefault();
    void router.push(`${url.pathname}${url.search}${url.hash}`)
        .catch(() =>
        {
            // Retain the current view without logging private navigation URLs.
        });
};

function runAppRouteMotion(el: Element, phase: MotionPhase, done: () => void): void
{
    if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement))
    {
        done();
        return;
    }

    let settled = false;
    const finish = (): void =>
    {
        if (settled)
        {
            return;
        }
        settled = true;
        cleanupByElement.get(el)?.();
        cleanupByElement.delete(el);
        done();
    };

    const controls = runMotion(el, {
        name: fsusBlogMotionPresets.route,
        phase,
        onFinish: finish
    });
    const removeCleanup = routeCleanup.add(() =>
    {
        controls.cancel();
        finish();
    });
    cleanupByElement.set(el, removeCleanup);
}

function runAppRouteEnter(el: Element, done: () => void): void
{
    runAppRouteMotion(el, 'enter', done);
}

function runAppRouteLeave(el: Element, done: () => void): void
{
    if (privateSurfaceRuntime.isClearing.value)
    {
        routeCleanup.cleanup();
        done();
        return;
    }
    runAppRouteMotion(el, 'leave', done);
}

useWindowEvents([
    { name: SESSION_EXPIRED_EVENT, handler: handleSessionExpired },
    { name: ADMIN_LOGOUT_EVENT, handler: handleAdminLogout }
]);

watch(
    () => [userStore.isAuthChecked, userStore.isLoggedIn] as const,
    ([checked]) =>
    {
        if (!checked)
        {
            return;
        }
        syncAuthPhase();
    },
    { immediate: true }
);

watch(
    () => route.fullPath,
    () =>
    {
        routeCleanup.cleanup();
        securityChallengeCoordinator.handleCancel();
    },
    { flush: 'pre' }
);

const stopStaticRouteTitleSync = syncStaticDocumentTitleOnLocaleChange(router.currentRoute, syncDocumentTitle);

onMounted(() =>
{
    document.addEventListener('click', onDocumentClick, { passive: false });
});

onUnmounted(() =>
{
    stopStaticRouteTitleSync();
    document.removeEventListener('click', onDocumentClick);
    routeCleanup.cleanup();
    privateSurfaceRuntime.setNavigationHandler(null);
});
</script>

<style>
html, body
 {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
}
</style>

<style scoped>
.banned-user-banner
 {
    background: var(--fsusblog-text-primary);
    color: var(--fsusblog-page-bg);
}
</style>
