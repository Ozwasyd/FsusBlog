import { createApp, createSSRApp } from 'vue'
import { createPinia } from 'pinia'
import { createHead } from '@unhead/vue/client'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import ElementPlus from '@ozwasyd/element-plus'
import App from '@/App.vue'
import router from '@/router'
import { provideFsusUiAppContext } from '@/config/fsusUiAppContext'
import { scheduleNonCriticalResources } from '@/bootstrap/nonCriticalResources'
import { scheduleFullAppRuntime } from '@/bootstrap/runtimeGate'
import { removeGlobalLoader } from '@/bootstrap/publicShellPrimitives'
import {
  beginPublicTakeoverHydration,
  completePublicTakeoverHydration,
  resetPublicTakeoverHydration
} from '@/bootstrap/publicTakeoverState'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'
import { authSessionRuntime } from '@/services/authSessionRuntime'
import '@/assets/main.css'

let bootstrapPromise: Promise<typeof router> | null = null

export function bootstrapFullApp(options?: { deferRuntime?: boolean; hydrate?: boolean; takeover?: 'public-shell' | 'direct' }): Promise<typeof router> {
  if (bootstrapPromise) {
    return bootstrapPromise
  }

  bootstrapPromise = (async () => {
    markStartup('full-app-bootstrap:start')
    const shouldHydrate = Boolean(options?.hydrate)
    const isPublicShellTakeover = shouldHydrate && options?.takeover === 'public-shell'

    if (isPublicShellTakeover) {
      beginPublicTakeoverHydration()
    }
    const shellBeforeMount = shouldHydrate
      ? document.querySelector<HTMLElement>('#fsus-aot-shell')
      : null
    const app = shouldHydrate ? createSSRApp(App) : createApp(App)
    const pinia = createPinia()
    const head = createHead()

    // FsusUI 1.4 MessageBox reads `center` during its initial render before
    // programmatic options are copied onto the instance.
    app.config.globalProperties.center = false

    app.use(head)
    pinia.use(piniaPluginPersistedstate)
    app.use(pinia)
    app.use(router)
    app.use(ElementPlus)
    provideFsusUiAppContext(app)
    authSessionRuntime.init(pinia)

    if (shouldHydrate) {
      await router.isReady()
      markStartup('full-app-bootstrap:router-ready-before-mount')
    }

    app.mount('#app', shouldHydrate)
    markStartup('full-app-bootstrap:mounted')
    scheduleFullAppRuntime(Boolean(options?.deferRuntime), {
      allowIdleActivation: !isPublicShellTakeover,
      allowScrollActivation: !isPublicShellTakeover
    })
    scheduleNonCriticalResources()

    await router.isReady()
    markStartup('full-app-bootstrap:router-ready')
    // Only verify hydration identity if not already hydrated as public shell
    if (shouldHydrate && shellBeforeMount) {
      const shellAfterMount = document.querySelector<HTMLElement>('#fsus-aot-shell')
      if (shellAfterMount !== shellBeforeMount) {
        throw new Error('[public-hydration] full-app remount detected: #fsus-aot-shell identity changed')
      }
    }
    if (isPublicShellTakeover) {
      completePublicTakeoverHydration()
    }
    measureStartup('full-app-bootstrap', 'full-app-bootstrap:start', 'full-app-bootstrap:mounted')
    measureStartup('router-ready-after-mount', 'full-app-bootstrap:mounted', 'full-app-bootstrap:router-ready')
    removeGlobalLoader()
    return router
  })().catch((error) => {
    bootstrapPromise = null
    if (options?.takeover === 'public-shell') {
      resetPublicTakeoverHydration()
    }
    throw error
  })

  return bootstrapPromise
}
