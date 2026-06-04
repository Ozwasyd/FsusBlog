<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useNotification } from '@/composables/useNotification'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'
import { isPublicSeoPath } from '@/bootstrap/publicShellPrimitives'

const { userStore, ensureSiteInfo, ensureUserInfo, syncAuthPhase } = useSessionBootstrap()
const { initNotification, stopNotification } = useNotification()

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
}

let hasTriggeredIntent = false
let intentTimer: ReturnType<typeof setTimeout> | null = null
let authBootstrapPromise: Promise<void> | null = null
let pendingNotificationMode: boolean | null = null
let notificationInitScheduled = false

const GUEST_INTENT_FALLBACK_MS = 5000
const GUEST_INTENT_PUBLIC_FALLBACK_MS = 12000
const NOTIFICATION_PUBLIC_IDLE_TIMEOUT_MS = 5200
const WASM_PREWARM_PUBLIC_IDLE_TIMEOUT_MS = 6500

function isPublicRouteNow(): boolean {
  return isPublicSeoPath(window.location.pathname)
}

function isAuthFlowRouteNow(): boolean {
  const path = window.location.pathname
  return path === '/login' || path === '/register'
}

function shouldStartGuestNotifications(): boolean {
  return !isPublicRouteNow() && !isAuthFlowRouteNow()
}

const runAfterFirstPaint = (task: () => void): void => {
  requestAnimationFrame(() => {
    window.setTimeout(task, 0)
  })
}

const runOnIdle = (task: () => void, timeout = 2500): void => {
  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(() => task(), { timeout })
    return
  }

  window.setTimeout(task, 600)
}

const requestNotificationInit = (loggedIn: boolean, errorLabel: string): void => {
  pendingNotificationMode = loggedIn
  if (notificationInitScheduled) {
    return
  }

  const scheduleInit = isPublicRouteNow()
    ? (task: () => void) => runOnIdle(task, NOTIFICATION_PUBLIC_IDLE_TIMEOUT_MS)
    : runAfterFirstPaint

  notificationInitScheduled = true
  scheduleInit(() => {
    notificationInitScheduled = false
    const mode = pendingNotificationMode
    pendingNotificationMode = null
    if (mode === null) {
      return
    }

    initNotification(mode).catch((error) => console.warn(errorLabel, error))
  })
}

watch(
  () => userStore.isLoggedIn,
  (loggedIn) => {
    if (!userStore.isAuthChecked) {
      return
    }

    if (isAuthFlowRouteNow() || (!loggedIn && isPublicRouteNow())) {
      return
    }

    console.log(`[AppRuntime] 身份状态变更: ${loggedIn ? '登录' : '登出'}，重调通知系统`)
    requestNotificationInit(loggedIn, '[AppRuntime] 身份切换通知初始化失败')
  }
)

const removeIntentListeners = () => {
  if (intentTimer) {
    clearTimeout(intentTimer)
    intentTimer = null
  }

  window.removeEventListener('scroll', triggerGlobalIntent)
  window.removeEventListener('mousemove', triggerGlobalIntent)
  window.removeEventListener('touchstart', triggerGlobalIntent)
}

const triggerGlobalIntent = async () => {
  if (!userStore.isAuthChecked) {
    return
  }

  if (hasTriggeredIntent || userStore.isLoggedIn || !shouldStartGuestNotifications()) {
    removeIntentListeners()
    return
  }

  hasTriggeredIntent = true
  removeIntentListeners()

  console.log('[AppRuntime] 捕获到真实访客行为，开始预热全局实时通讯...')
  requestNotificationInit(false, '[AppRuntime] 游客连接建立受限')
}

function bindGuestIntentListeners(): void {
  if (hasTriggeredIntent || !shouldStartGuestNotifications()) {
    return
  }

  window.addEventListener('scroll', triggerGlobalIntent, { once: true, passive: true })
  window.addEventListener('mousemove', triggerGlobalIntent, { once: true, passive: true })
  window.addEventListener('touchstart', triggerGlobalIntent, { once: true, passive: true })
  intentTimer = setTimeout(
    triggerGlobalIntent,
    isPublicRouteNow() ? GUEST_INTENT_PUBLIC_FALLBACK_MS : GUEST_INTENT_FALLBACK_MS
  )
}

function bootstrapAuthAndSiteState(): Promise<void> {
  if (authBootstrapPromise) {
    return authBootstrapPromise
  }

  authBootstrapPromise = (async () => {
    markStartup('runtime-bootstrap:start')
    const siteTask = ensureSiteInfo()
    const userTask = ensureUserInfo()

    await Promise.allSettled([userTask])
    syncAuthPhase()

    if (userStore.isLoggedIn) {
      requestNotificationInit(true, '[AppRuntime] 用户连接失败')
    } else {
      bindGuestIntentListeners()
    }

    await Promise.allSettled([siteTask, userTask])
    markStartup('runtime-bootstrap:ready')
    measureStartup('runtime-bootstrap', 'runtime-bootstrap:start', 'runtime-bootstrap:ready')
  })()

  return authBootstrapPromise
}

onMounted(() => {
  markStartup('runtime-mounted')
  measureStartup('entry-to-runtime-mounted', 'entry', 'runtime-mounted')

  runOnIdle(() => {
    void import('@wasm/aeds')
      .then(({ initWasm }) => initWasm())
      .catch(() => {})
  }, isPublicRouteNow() ? WASM_PREWARM_PUBLIC_IDLE_TIMEOUT_MS : 3000)

  if (!isPublicRouteNow()) {
    runOnIdle(() => {
      void import('@/composables/usePow')
        .then(({ usePow }) => {
          usePow().prewarm()
        })
        .catch(() => {})
    }, 2200)
  }

  runAfterFirstPaint(() => {
    void bootstrapAuthAndSiteState()
  })
})

onUnmounted(() => {
  removeIntentListeners()
  void stopNotification()
})
</script>

<template></template>
