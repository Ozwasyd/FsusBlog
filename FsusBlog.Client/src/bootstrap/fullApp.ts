import { createApp, createSSRApp } from 'vue'
import { createPinia } from 'pinia'
import { createHead } from '@unhead/vue/client'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import ElementPlus from '@ozwasyd/element-plus'
import App from '@/App.vue'
import router from '@/router'
import { scheduleNonCriticalResources } from '@/bootstrap/nonCriticalResources'
import { scheduleFullAppRuntime } from '@/bootstrap/runtimeGate'
import { removeGlobalLoader } from '@/bootstrap/publicShellPrimitives'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'
import { authSessionRuntime } from '@/services/authSessionRuntime'
import '@/assets/main.css'

let bootstrapPromise: Promise<typeof router> | null = null

export function bootstrapFullApp(options?: { deferRuntime?: boolean; hydrate?: boolean }): Promise<typeof router> {
  if (bootstrapPromise) {
    return bootstrapPromise
  }

  bootstrapPromise = (async () => {
    markStartup('full-app-bootstrap:start')
    const shouldHydrate = Boolean(options?.hydrate)
    const shellBeforeMount = shouldHydrate
      ? document.querySelector<HTMLElement>('#fsus-aot-shell')
      : null
    const appRootBeforeMount = shouldHydrate
      ? document.querySelector<HTMLElement>('#app')
      : null
    const firstChildBeforeMount = appRootBeforeMount?.firstElementChild ?? null
    const childCountBeforeMount = appRootBeforeMount?.childElementCount ?? 0
    const app = shouldHydrate ? createSSRApp(App) : createApp(App)
    const pinia = createPinia()
    const head = createHead()

    app.use(head)
    pinia.use(piniaPluginPersistedstate)
    app.use(pinia)
    app.use(router)
    app.use(ElementPlus)
    authSessionRuntime.init(pinia)

    app.mount('#app', shouldHydrate)
    markStartup('full-app-bootstrap:mounted')
    scheduleFullAppRuntime(Boolean(options?.deferRuntime))
    scheduleNonCriticalResources()

    await router.isReady()
    markStartup('full-app-bootstrap:router-ready')
    if (shouldHydrate && shellBeforeMount) {
      const shellAfterMount = document.querySelector<HTMLElement>('#fsus-aot-shell')
      if (shellAfterMount !== shellBeforeMount) {
        throw new Error('[public-hydration] full-app remount detected: #fsus-aot-shell identity changed')
      }
      if (
        appRootBeforeMount &&
        (appRootBeforeMount.firstElementChild !== firstChildBeforeMount || appRootBeforeMount.childElementCount !== childCountBeforeMount)
      ) {
        throw new Error('[public-hydration] full-app remount detected: #app subtree rebuilt')
      }
    }
    measureStartup('full-app-bootstrap', 'full-app-bootstrap:start', 'full-app-bootstrap:mounted')
    measureStartup('router-ready-after-mount', 'full-app-bootstrap:mounted', 'full-app-bootstrap:router-ready')
    removeGlobalLoader()
    return router
  })()

  return bootstrapPromise
}
