import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useSiteStore } from '@/store/site'
import { useUserStore } from '@/store/user'
import { getKnownErrorInfo } from '@/utils/errorKinds'

export type BootstrapPhase = 'idle' | 'bootstrapping' | 'ready' | 'error'
export type AuthPhase = 'unknown' | 'guest' | 'authenticated'
export type RuntimePhase = 'shell-visible' | 'runtime-loading' | 'runtime-ready'

export const useAppShellStore = defineStore('app-shell', () => {
  const bootstrapPhase = ref<BootstrapPhase>('idle')
  const authPhase = ref<AuthPhase>('unknown')
  const runtimePhase = ref<RuntimePhase>('shell-visible')
  const riskPhase = ref<'normal' | 'elevated'>('normal')
  const sessionPhase = ref<'active' | 'refreshing' | 'expired'>('active')

  const bootstrapError = ref<string>('')
  let bootstrapPromise: Promise<void> | null = null

  const isReady = computed(() => bootstrapPhase.value === 'ready')

  const syncAuthPhase = () => {
    const userStore = useUserStore()
    authPhase.value = userStore.isLoggedIn ? 'authenticated' : 'guest'
  }

  const bootstrap = async (force = false): Promise<void> => {
    if (bootstrapPromise && !force) {
      return bootstrapPromise
    }

    bootstrapPromise = (async () => {
      const siteStore = useSiteStore()
      const userStore = useUserStore()
      bootstrapPhase.value = 'bootstrapping'
      bootstrapError.value = ''
      try {
        await Promise.all([
          siteStore.fetchSiteInfo(force),
          userStore.fetchUserInfo(force)
        ])
        syncAuthPhase()
        bootstrapPhase.value = 'ready'
      } catch (error) {
        bootstrapPhase.value = 'error'
        bootstrapError.value = getKnownErrorInfo(error, '应用初始化失败').message
      }
    })()

    return bootstrapPromise
  }

  const setRuntimePhase = (phase: RuntimePhase) => {
    runtimePhase.value = phase
  }

  const markSessionExpired = () => {
    sessionPhase.value = 'expired'
    authPhase.value = 'guest'
  }

  const markSessionActive = () => {
    sessionPhase.value = 'active'
  }

  const markSessionRefreshing = () => {
    sessionPhase.value = 'refreshing'
  }

  const setRiskPhase = (phase: 'normal' | 'elevated') => {
    riskPhase.value = phase
  }

  return {
    bootstrapPhase,
    authPhase,
    runtimePhase,
    sessionPhase,
    riskPhase,
    bootstrapError,
    isReady,
    bootstrap,
    syncAuthPhase,
    setRuntimePhase,
    markSessionExpired,
    markSessionRefreshing,
    markSessionActive,
    setRiskPhase
  }
})
