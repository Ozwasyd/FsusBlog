<script setup lang="ts">
    import { computed, defineAsyncComponent, watch } from 'vue'
    import { RouterView, useRouter } from 'vue-router'
    import { useHead } from '@unhead/vue'

    import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
    import { useWindowEvents } from '@/composables/useWindowEvents'
    import { handleRootAotClick } from '@/bootstrap/aotActionBridge'
    import { SESSION_EXPIRED_EVENT, type SessionExpiredDetail } from '@/bootstrap/sessionExpiryBridge'
    import { runtimePhase, runtimeReady } from '@/bootstrap/runtimeGate'
    import { useThemeRuntime } from '@/services/themeRuntime'

    const router = useRouter()
    const { userStore, siteStore, syncAuthPhase, setRuntimePhase } = useSessionBootstrap()
    const FullAppRuntime = defineAsyncComponent(() => import('@/components/runtime/AppRuntime.vue'))
    const { resolvedTheme } = useThemeRuntime()

    // [修复 2026-02-23] 解决 SEO 元数据响应式隐患：
    // 使用统一的 computed 对象包裹整个 head 配置，确保 vueuse/head 能够精准追踪依赖变化
    const headConfig = computed(() => ({
        titleTemplate: (titleChunk: string | undefined) => {
            const siteTitle = siteStore.siteInfo.title
            return titleChunk ? `${titleChunk} - ${siteTitle}` : siteTitle
        },
        meta: [
            { name: 'description', content: siteStore.siteInfo.description },
            { name: 'keywords', content: siteStore.siteInfo.keywords },
            { name: 'viewport', content: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no' },
            { name: 'color-scheme', content: resolvedTheme.value }
        ],
        bodyAttrs: {
            class: 'overflow-x-hidden selection:bg-[#0F0F11] selection:text-white dark:selection:bg-[#FCFCFC] dark:selection:text-[#0F0F11]'
        }
    }))
    
    useHead(headConfig)

    const onRootClick = (event: MouseEvent) => {
        void handleRootAotClick(event, router)
    }

    const handleSessionExpired = (event: Event): void => {
        const detail = (event as CustomEvent<SessionExpiredDetail>).detail
        const currentPath = detail?.currentPath || window.location.pathname
        const currentRoute = router.currentRoute.value
        const requiresAuth = Boolean(currentRoute.meta.requiresAuth)

        if (currentPath.includes('/login') || currentPath.includes('/register')) {
            return
        }

        if (userStore.isLoggedIn || userStore.userInfo?.role || requiresAuth) {
            void router.push(`/login?redirect=${encodeURIComponent(currentPath)}`)
        }
    }

    useWindowEvents([{ name: SESSION_EXPIRED_EVENT, handler: handleSessionExpired }])

    watch(
        () => [userStore.isAuthChecked, userStore.isLoggedIn] as const,
        ([checked]) => {
            if (!checked) {
                return
            }
            syncAuthPhase()
        },
        { immediate: true }
    )

    watch(
        () => runtimePhase.value,
        (phase) => {
            setRuntimePhase(phase)
        },
        { immediate: true }
    )

</script>

<template>
        <div class="app-wrapper w-full min-h-screen flex flex-col overflow-x-hidden" @click="onRootClick">
            <!-- [修复 2026-02-23] 解决权限 UI 闪烁：增加 isAuthChecked 判定，确保握手后再渲染 -->
            <transition name="banner-slide">
                <div v-if="userStore.isAuthChecked && userStore.isLoggedIn && userStore.isBanned"
                     class="w-full bg-[#0F0F11] text-white py-2 px-6 flex items-center justify-center gap-6 z-200 relative">
                    <span class="text-[10px] font-bold tracking-[0.2em] uppercase">
                        当前账号处于管控状态：{{ userStore.userInfo?.banReason || '仅限阅读模式' }}
                    </span>
                    <router-link to="/user/messagebox" class="text-[9px] underline underline-offset-4 opacity-70 hover:opacity-100 transition-opacity uppercase font-bold tracking-widest">
                        查看详情
                    </router-link>
                </div>
            </transition>

            <router-view v-slot="{ Component }">
                <transition name="page-fade" mode="out-in">
                    <component :is="Component" />
                </transition>
            </router-view>
            <FullAppRuntime v-if="runtimeReady" />
        </div>
</template>

<style>
    @reference "@/assets/main.css";

    html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        scroll-behavior: smooth;
        -webkit-tap-highlight-color: transparent;
    }

    * {
        box-sizing: border-box;
    }

    .page-fade-enter-active,
    .page-fade-leave-active {
        transition: opacity 0.25s ease;
    }

    .page-fade-enter-from,
    .page-fade-leave-to {
        opacity: 0;
    }

    .banner-slide-enter-active, .banner-slide-leave-active {
        transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .banner-slide-enter-from, .banner-slide-leave-to {
        transform: translateY(-100%);
    }
</style>
