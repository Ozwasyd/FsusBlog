<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, watch } from 'vue'
import { RouterView, useRouter, useRoute } from 'vue-router'
import { useHead } from '@unhead/vue'

import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { handleRootAotClick } from '@/bootstrap/aotActionBridge'
import { SESSION_EXPIRED_EVENT, type SessionExpiredDetail } from '@/bootstrap/sessionExpiryBridge'
import { runtimePhase, runtimeReady } from '@/bootstrap/runtimeGate'
import { isPublicSeoRouteName, isPublicShellRouteName } from '@/public-renderers/publicPageModel'
import { useThemeRuntime } from '@/services/themeRuntime'
import { FSUSBLOG_RENDER_PIPELINE_CONFIG } from '@/fsusui/renderPipeline'

const router = useRouter()
const route = useRoute()
const { userStore, siteStore, syncAuthPhase, setRuntimePhase } = useSessionBootstrap()
const FullAppRuntime = defineAsyncComponent(() => import('@/components/runtime/AppRuntime.vue'))
const { mode } = useThemeRuntime()
const headConfig = computed(() => ({
  titleTemplate: (titleChunk: string | undefined) => {
    const siteTitle = siteStore.siteInfo.title
    return titleChunk ? `${titleChunk} - ${siteTitle}` : siteTitle
  },
  meta: [
    { name: 'description', content: siteStore.siteInfo.description },
    { name: 'keywords', content: siteStore.siteInfo.keywords },
    { name: 'viewport', content: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no' }
  ]
}))

useHead(headConfig)

const isPublicSeoRoute = computed(() => isPublicSeoRouteName(route.name))

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

function shouldHandleSpaAnchor(anchor: HTMLAnchorElement): boolean {
  if (!runtimeReady.value || !isPublicSeoRoute.value) {
    return false
  }

  if (anchor.target && anchor.target !== '_self') {
    return false
  }

  if (anchor.hasAttribute('download')) {
    return false
  }

  const rawHref = anchor.getAttribute('href')
  if (!rawHref || rawHref.startsWith('#')) {
    return false
  }

  const url = new URL(anchor.href, window.location.origin)
  if (url.origin !== window.location.origin) {
    return false
  }

  if (url.pathname.startsWith('/api/')) {
    return false
  }

  const resolved = router.resolve(`${url.pathname}${url.search}${url.hash}`)
  return isPublicShellRouteName(resolved.name)
}

const onDocumentClick = (event: MouseEvent): void => {
  if (!runtimeReady.value) {
    void handleRootAotClick(event, router)
  }

  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return
  }

  const target = event.target
  if (!(target instanceof Element)) {
    return
  }

  const anchor = target.closest('a')
  if (!(anchor instanceof HTMLAnchorElement) || !shouldHandleSpaAnchor(anchor)) {
    return
  }

  const url = new URL(anchor.href, window.location.origin)
  event.preventDefault()
  void router.push(`${url.pathname}${url.search}${url.hash}`)
    .catch(() => {})
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

onMounted(() => {
  document.addEventListener('click', onDocumentClick, { passive: false })
})

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
})
</script>

<template>
  <el-config-provider
    :theme-mode="mode"
    :render-pipeline="FSUSBLOG_RENDER_PIPELINE_CONFIG"
  >
    <RouterView v-if="isPublicSeoRoute" />
    <div v-else class="app-wrapper w-full min-h-screen flex flex-col overflow-x-hidden">
      <transition name="banner-slide">
        <div
          v-if="userStore.isAuthChecked && userStore.isLoggedIn && userStore.isBanned"
          class="banned-user-banner w-full py-2 px-6 flex items-center justify-center gap-6 z-200 relative"
        >
          <span class="text-[10px] font-bold tracking-normal uppercase">
            当前账号处于管控状态：{{ userStore.userInfo?.banReason || '仅限阅读模式' }}
          </span>
          <router-link to="/user/messagebox" class="text-[9px] underline underline-offset-4 opacity-70 hover:opacity-100 transition-opacity uppercase font-bold tracking-normal">
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
  </el-config-provider>
</template>

<style>
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
}
</style>

<style scoped>
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.page-fade-enter-from,
.page-fade-leave-to {
  opacity: 0;
}

.banner-slide-enter-active, .banner-slide-leave-active {
  transition: transform var(--fsus-motion-control) var(--fsus-motion-standard);
}

.banner-slide-enter-from, .banner-slide-leave-to {
  transform: translateY(-100%);
}

.banned-user-banner {
  background: var(--fsusblog-text-primary);
  color: var(--fsusblog-page-bg);
}

@media (prefers-reduced-motion: reduce) {
  .page-fade-enter-active,
  .page-fade-leave-active,
  .banner-slide-enter-active,
  .banner-slide-leave-active {
    transition: none;
  }
}
</style>
