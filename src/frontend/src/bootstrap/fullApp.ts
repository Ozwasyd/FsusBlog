import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createHead } from '@unhead/vue/client'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from '@/App.vue'
import router from '@/router'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import { installFsusUiLoading } from '@/fsusui/feedback'
import { FsuMotion } from '@/fsusui/motion'
import { scheduleNonCriticalResources } from '@/bootstrap/nonCriticalResources'
import { scheduleFullAppRuntime } from '@/bootstrap/runtimeGate'
import { removeGlobalLoader } from '@/bootstrap/publicShellPrimitives'
import { disposePublicHydrationApp } from '@/public-renderers/clientHydrate'
import {
  beginPublicTakeoverCommit,
  completePublicTakeoverCommit,
  resetPublicTakeover
} from '@/bootstrap/publicTakeoverState'
import { abortPublicShellLifetime } from '@/bootstrap/publicShellLifetime'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'
import { authSessionRuntime } from '@/services/authSessionRuntime'
import '@/assets/main.css'

let bootstrapPromise: Promise<typeof router> | null = null

function disposePublicShellForClientMount(): void {
  const appRoot = document.getElementById('app')
  if (!appRoot) {
    return
  }

  const shell = appRoot.querySelector<HTMLElement>('#fsus-aot-shell')
  if (shell?.dataset.publicHydrationKind) {
    appRoot.dataset.publicTakeoverDisposedShell = shell.dataset.publicHydrationKind
  }

  disposePublicHydrationApp()
  appRoot.replaceChildren()
}

function markDirectPublicShellReady(): void {
  const shell = document.querySelector<HTMLElement>('#fsus-aot-shell')
  if (shell?.dataset.publicHydrationKind) {
    shell.dataset.publicHydrated = 'true'
  }
}

function readCurrentBrowserRoute(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
}

async function syncRouterToCurrentLocationForClientMount(): Promise<void> {
  const targetRoute = readCurrentBrowserRoute()
  if (router.currentRoute.value.fullPath === targetRoute) {
    return
  }

  await router.replace(targetRoute).catch(() => {})
}

export function bootstrapFullApp(options?: { deferRuntime?: boolean; hydrate?: boolean; takeover?: 'public-shell' | 'direct' }): Promise<typeof router> {
  if (bootstrapPromise) {
    return bootstrapPromise
  }

  bootstrapPromise = (async () => {
    markStartup('full-app-bootstrap:start')
    const isPublicShellTakeover = options?.takeover === 'public-shell'

    if (isPublicShellTakeover) {
      beginPublicTakeoverCommit({ reason: 'full-app-bootstrap' })
      abortPublicShellLifetime('full-app-bootstrap')
      disposePublicShellForClientMount()
    }
    const app = createApp(App)
    const pinia = createPinia()
    const head = createHead()

    // FsusUI 1.4 MessageBox reads `center` during its initial render before
    // programmatic options are copied onto the instance.
    app.config.globalProperties.center = false

    app.use(head)
    pinia.use(piniaPluginPersistedstate)
    app.use(pinia)
    app.use(router)
    installFsusUiLoading(app)
    app.use(FsuMotion)
    provideFsusUiAppContext(app)
    authSessionRuntime.init(pinia)

    if (isPublicShellTakeover) {
      await syncRouterToCurrentLocationForClientMount()
      await router.isReady()
      markStartup('full-app-bootstrap:router-ready-before-mount')
    }

    app.mount('#app')
    markStartup('full-app-bootstrap:mounted')
    scheduleFullAppRuntime(Boolean(options?.deferRuntime), {
      allowIdleActivation: !isPublicShellTakeover,
      allowScrollActivation: !isPublicShellTakeover
    })
    scheduleNonCriticalResources()

    await router.isReady()
    markStartup('full-app-bootstrap:router-ready')
    if (isPublicShellTakeover) {
      completePublicTakeoverCommit({ reason: 'full-app-mounted' })
    } else {
      markDirectPublicShellReady()
    }
    measureStartup('full-app-bootstrap', 'full-app-bootstrap:start', 'full-app-bootstrap:mounted')
    measureStartup('router-ready-after-mount', 'full-app-bootstrap:mounted', 'full-app-bootstrap:router-ready')
    removeGlobalLoader()
    return router
  })().catch((error) => {
    bootstrapPromise = null
    if (options?.takeover === 'public-shell') {
      resetPublicTakeover({ reason: 'full-app-bootstrap-failed' })
    }
    throw error
  })

  return bootstrapPromise
}
