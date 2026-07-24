import { createApp, h, type Component, type VNode } from 'vue'
import { createPinia } from 'pinia'
import { createHead } from '@unhead/vue/client'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from '@/App.vue'
import { createAppRouter } from '@/router'
import {
  prewarmPublicRoute,
  type PublicRoutePrewarmOptions,
  type PublicRoutePrewarmResult
} from '@/router/publicRoutePreload'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import { installFsusUiLoading } from '@/fsusui/feedback'
import { scheduleNonCriticalResources } from '@/bootstrap/nonCriticalResources'
import { runtimeReady, scheduleFullAppRuntime } from '@/bootstrap/runtimeGate'
import { removeGlobalLoader } from '@/bootstrap/publicShellPrimitives'
import {
  getPublicHydrationTakeoverHandle,
  type PublicHydrationTakeoverHandle
} from '@/public-renderers/clientHydrate'
import type { PublicHydrationPayload } from '@/public-renderers/types'
import {
  isPublicSearchRouteName,
  isPublicShellRouteName,
  resolvePublicPageKind
} from '@/public-renderers/publicPageModel'
import { PUBLIC_SEARCH_ROUTE_NAME } from '@/public-renderers/publicRouteRegistry'
import { normalizePublicSearchKeyword } from '@/public-renderers/publicSearchRoutePolicy'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'
import { createPublicTakeoverSeed } from '@/public-renderers/publicSiteIdentity'
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
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import { authSessionRuntime } from '@/services/authSessionRuntime'
import '@/assets/main.css'

const router = createAppRouter({
  prewarmPublicRoute
})

export type BootstrapFullAppOptions = {
  deferRuntime?: boolean
  hydrate?: boolean
  takeover?: 'public-shell' | 'direct'
}

export type FullAppNavigationIntent = Readonly<{
  to: string
  replace?: boolean
}>

export function prewarmFullAppRoute(
  target: string | URL,
  options: PublicRoutePrewarmOptions
): Promise<PublicRoutePrewarmResult> {
  return prewarmPublicRoute(target, options)
}

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
  isDirectSpaBootstrap: boolean
  publicTakeover: PublicHydrationTakeoverHandle | null
}>

let bootstrapPromise: Promise<typeof router> | null = null
let deferredMotionInstallStarted = false

type IdleWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
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
  if (!prepared.isPublicShellTakeover) {
    pinia.use(piniaPluginPersistedstate)
    app.use(pinia)
  }
  app.use(router)
  installFsusUiLoading(app)
  if (!prepared.isPublicShellTakeover) {
    provideFsusUiAppContext(app)
  }
}

function resolvePublicRouteProps(): Record<string, unknown> {
  const route = router.currentRoute.value
  const record = route.matched.at(-1)
  const option = record?.props?.default
  if (option === true) {
    return { ...route.params }
  }
  if (typeof option === 'function') {
    return option(route)
  }
  return option && typeof option === 'object' ? { ...option } : {}
}

function renderPublicRouteComponent(): VNode | null {
  const route = router.currentRoute.value
  const component = route.matched.at(-1)?.components?.default as Component | undefined
  if (!component) {
    return null
  }

  return h(component, {
    ...resolvePublicRouteProps(),
    key: route.fullPath
  })
}

function createPublicTakeoverRenderer(payload: PublicHydrationPayload): () => VNode {
  const shellSeed = createPublicTakeoverSeed(payload)
  if (!shellSeed) {
    throw new Error('public takeover hydration payload is unavailable')
  }

  const handleSearch = async (query: string): Promise<void> => {
    const canonicalQuery = normalizePublicSearchKeyword(query)
    if (!canonicalQuery) {
      return
    }

    const route = router.currentRoute.value
    if (isPublicSearchRouteName(route.name) && route.query.q === canonicalQuery) {
      return
    }

    await router.push({ name: PUBLIC_SEARCH_ROUTE_NAME, query: { q: canonicalQuery } })
  }

  const handleNavigate = async (href: string): Promise<void> => {
    await router.push(href)
  }

  const handleSearchFocus = (): void => {
    window.dispatchEvent(new CustomEvent('fsus:public-shell:search-focus'))
  }

  return (): VNode => {
    const route = router.currentRoute.value
    if (!isPublicShellRouteName(route.name)) {
      return h(App)
    }

    const hydrationKind = resolvePublicPageKind(route.name) ?? payload.pageKind
    const shellState = createPublicShellViewState({
      hydrationKind,
      siteTitle: shellSeed.siteTitle,
      siteDescription: shellSeed.siteDescription,
      siteLogoUrl: shellSeed.siteLogoUrl,
      siteLogoDarkUrl: shellSeed.siteLogoDarkUrl,
      siteWordmarkUrl: shellSeed.siteWordmarkUrl,
      compliance: shellSeed.compliance,
      renderYear: shellSeed.renderYear,
      isSearchRoute: isPublicSearchRouteName(route.name),
      initialSearchQuery: isPublicSearchRouteName(route.name) ? String(route.query.q ?? '') : '',
      spaSearch: runtimeReady.value,
      showRuntime: runtimeReady.value
    })

    return h(PublicBlogLayoutShell, {
      ...shellState,
      initialLocale: shellSeed.renderLocale,
      spaNavigation: true,
      onNavigate: handleNavigate,
      onSearch: handleSearch,
      onSearchFocus: handleSearchFocus
    }, {
      default: renderPublicRouteComponent
    })
  }
}

function installDeferredFsusMotion(prepared: PreparedFullApp): void {
  if (deferredMotionInstallStarted) {
    return
  }

  deferredMotionInstallStarted = true
  const install = (): void => {
    void import('@ozwasyd/element-plus/motion')
      .then(({ FsuMotion }) => {
        prepared.app.use(FsuMotion)
        markStartup('full-app-bootstrap:motion-ready')
      })
      .catch(() => {
        deferredMotionInstallStarted = false
      })
  }

  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(install, { timeout: 1600 })
    return
  }

  window.setTimeout(install, 1200)
}

export function prepareFullApp(options: BootstrapFullAppOptions = {}): PreparedFullApp {
  markStartup('full-app-bootstrap:start')
  const isPublicShellTakeover = options.takeover === 'public-shell'
  const isDirectSpaBootstrap = !isPublicShellTakeover
    && !document.getElementById('app')?.querySelector('#fsus-aot-shell')
  const publicTakeover = isPublicShellTakeover ? getPublicHydrationTakeoverHandle() : null
  if (isPublicShellTakeover && !publicTakeover) {
    throw new Error('public takeover requires the mounted hydration app')
  }
  const prepared: PreparedFullApp = {
    app: publicTakeover?.app ?? createApp(App),
    pinia: publicTakeover?.pinia ?? createPinia(),
    head: createHead(),
    router,
    options,
    isPublicShellTakeover,
    isDirectSpaBootstrap,
    publicTakeover
  }

  if (isDirectSpaBootstrap) {
    beginPublicTakeoverCommit({ reason: 'direct-spa-bootstrap' })
  }

  try {
    installFullAppPlugins(prepared)
  } catch (error) {
    if (isDirectSpaBootstrap) {
      resetPublicTakeover({ reason: 'direct-spa-prepare-failed' })
    }
    throw error
  }
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
      await syncRouterToCurrentLocationForClientMount()
      await router.isReady()
      markStartup('full-app-bootstrap:router-ready-before-mount')
    }

    authBroadcastRuntime.init(prepared.pinia)
    authSessionRuntime.init(prepared.pinia)
    if (prepared.publicTakeover) {
      await prepared.publicTakeover.activate(createPublicTakeoverRenderer(prepared.publicTakeover.payload))
    } else {
      prepared.app.mount('#app')
    }
    markStartup('full-app-bootstrap:mounted')
    scheduleFullAppRuntime(Boolean(prepared.options.deferRuntime), {
      allowIdleActivation: !prepared.isPublicShellTakeover,
      allowScrollActivation: !prepared.isPublicShellTakeover
    })
    installDeferredFsusMotion(prepared)
    scheduleNonCriticalResources()

    await router.isReady()
    await replayNavigationIntent(options.navigationIntent)
    await waitForPublicTakeoverVisualReady(visualGuard)
    markStartup('full-app-bootstrap:router-ready')
    if (prepared.isPublicShellTakeover) {
      completePublicTakeoverCommit({ reason: 'full-app-mounted' })
    } else if (prepared.isDirectSpaBootstrap) {
      completePublicTakeoverCommit({ reason: 'direct-spa-mounted' })
      markDirectPublicShellReady()
    } else {
      markDirectPublicShellReady()
    }
    measureStartup('full-app-bootstrap', 'full-app-bootstrap:start', 'full-app-bootstrap:mounted')
    measureStartup('router-ready-after-mount', 'full-app-bootstrap:mounted', 'full-app-bootstrap:router-ready')
    removeGlobalLoader()
    return router
  } catch (error) {
    if (prepared.isPublicShellTakeover || prepared.isDirectSpaBootstrap) {
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
