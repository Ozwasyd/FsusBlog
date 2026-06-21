import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createHead } from '@unhead/vue/client'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from '@/App.vue'
import router from '@/router'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import { installFsusUiLoading } from '@/fsusui/feedback'
import { FsuMotion } from '@ozwasyd/element-plus/motion'
import { scheduleNonCriticalResources } from '@/bootstrap/nonCriticalResources'
import { scheduleFullAppRuntime } from '@/bootstrap/runtimeGate'
import { removeGlobalLoader } from '@/bootstrap/publicShellPrimitives'
import { disposePublicHydrationApp } from '@/public-renderers/clientHydrate'
import {
  beginPublicTakeoverCommit,
  completePublicTakeoverCommit,
  resetPublicTakeover
} from '@/bootstrap/publicTakeoverState'
import {
  DEFAULT_PUBLIC_TAKEOVER_ROUTE_READY_TIMEOUT_MS,
  beginPublicTakeoverVisualGuard,
  waitForPublicTakeoverVisualReady
} from '@/bootstrap/publicTakeoverController'
import { abortPublicShellLifetime } from '@/bootstrap/publicShellLifetime'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'
import { authSessionRuntime } from '@/services/authSessionRuntime'
import '@/assets/main.css'

export type BootstrapFullAppOptions = {
  deferRuntime?: boolean
  hydrate?: boolean
  takeover?: 'public-shell' | 'direct'
}

export type FullAppNavigationIntent = Readonly<{
  to: string
  replace?: boolean
}>

export type CommitPreparedFullAppOptions = Readonly<{
  navigationIntent?: FullAppNavigationIntent
  routeReadinessTimeoutMs?: number
}>

export type PreparedFullApp = Readonly<{
  app: ReturnType<typeof createApp>
  pinia: ReturnType<typeof createPinia>
  head: ReturnType<typeof createHead>
  router: typeof router
  options: BootstrapFullAppOptions
  isPublicShellTakeover: boolean
}>

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

function installFullAppPlugins(prepared: PreparedFullApp): void {
  const { app, pinia, head } = prepared

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
}

export function prepareFullApp(options: BootstrapFullAppOptions = {}): PreparedFullApp {
  markStartup('full-app-bootstrap:start')
  const prepared: PreparedFullApp = {
    app: createApp(App),
    pinia: createPinia(),
    head: createHead(),
    router,
    options,
    isPublicShellTakeover: options.takeover === 'public-shell'
  }

  installFullAppPlugins(prepared)
  return prepared
}

async function replayNavigationIntent(intent: FullAppNavigationIntent | undefined): Promise<void> {
  if (!intent) {
    return
  }

  if (intent.replace) {
    await router.replace(intent.to)
    return
  }

  await router.push(intent.to)
}

function resolvePublicTakeoverNavigationId(options: CommitPreparedFullAppOptions): string {
  return options.navigationIntent?.to ?? readCurrentBrowserRoute()
}

export async function commitPreparedFullApp(
  prepared: PreparedFullApp,
  options: CommitPreparedFullAppOptions = {}
): Promise<typeof router> {
  try {
    const visualGuard = prepared.isPublicShellTakeover
      ? beginPublicTakeoverVisualGuard({
          navigationId: resolvePublicTakeoverNavigationId(options),
          timeoutMs: options.routeReadinessTimeoutMs ?? DEFAULT_PUBLIC_TAKEOVER_ROUTE_READY_TIMEOUT_MS
        })
      : null

    if (prepared.isPublicShellTakeover) {
      beginPublicTakeoverCommit({ reason: 'full-app-bootstrap' })
      abortPublicShellLifetime('full-app-bootstrap')
      disposePublicShellForClientMount()
      await syncRouterToCurrentLocationForClientMount()
      await router.isReady()
      markStartup('full-app-bootstrap:router-ready-before-mount')
    }

    authSessionRuntime.init(prepared.pinia)
    prepared.app.mount('#app')
    markStartup('full-app-bootstrap:mounted')
    scheduleFullAppRuntime(Boolean(prepared.options.deferRuntime), {
      allowIdleActivation: !prepared.isPublicShellTakeover,
      allowScrollActivation: !prepared.isPublicShellTakeover
    })
    scheduleNonCriticalResources()

    await router.isReady()
    await replayNavigationIntent(options.navigationIntent)
    await waitForPublicTakeoverVisualReady(visualGuard)
    markStartup('full-app-bootstrap:router-ready')
    if (prepared.isPublicShellTakeover) {
      completePublicTakeoverCommit({ reason: 'full-app-mounted' })
    } else {
      markDirectPublicShellReady()
    }
    measureStartup('full-app-bootstrap', 'full-app-bootstrap:start', 'full-app-bootstrap:mounted')
    measureStartup('router-ready-after-mount', 'full-app-bootstrap:mounted', 'full-app-bootstrap:router-ready')
    removeGlobalLoader()
    return router
  } catch (error) {
    if (prepared.isPublicShellTakeover) {
      resetPublicTakeover({ reason: 'full-app-bootstrap-failed' })
    }

    throw error
  }
}

export function bootstrapFullApp(options?: BootstrapFullAppOptions): Promise<typeof router> {
  if (bootstrapPromise) {
    return bootstrapPromise
  }

  bootstrapPromise = (async () => {
    const prepared = prepareFullApp(options)
    return await commitPreparedFullApp(prepared)
  })().catch((error) => {
    bootstrapPromise = null
    throw error
  })

  return bootstrapPromise
}
