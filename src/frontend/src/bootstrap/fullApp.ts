import { createApp, defineAsyncComponent, defineComponent, Fragment, h, type Component, type VNode } from 'vue'
import { createPinia } from 'pinia'
import { createHead } from '@unhead/vue/client'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import App from '@/App.vue'
import { createAppRouter } from '@/router'
import {
  beginLocaleRouteTransaction,
  activateLocaleRuntime,
  isSupportedLocale
} from '@/locales'
import { requiredLocaleDomainsForRoute } from '@/locales/routeLocaleDomains'
import { prewarmPublicRoute } from '@/router/publicRoutePreload'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import { installFsusUiLoading } from '@/fsusui/feedback'
import { scheduleNonCriticalResources } from '@/bootstrap/nonCriticalResources'
import { runtimeActive, scheduleRuntimeActivation } from '@/bootstrap/runtimeActivation'
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
  DEFAULT_PUBLIC_TAKEOVER_ROUTE_READY_TIMEOUT_MS,
  beginPublicTakeoverVisualGuard,
  waitForPublicTakeoverVisualReady
} from '@/bootstrap/publicTakeoverController'
import { abortPublicShellLifetime } from '@/bootstrap/publicShellLifetime'
import { markStartup, measureStartup } from '@/bootstrap/startupProfiler'
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import { authSessionRuntime } from '@/services/authSessionRuntime'
import '@/assets/main.css'

export type BootstrapFullAppOptions = {
  hydrate?: boolean
  takeover?: 'public-shell' | 'direct'
  getPublicActivationOwner?: () => 'aot' | 'full-app'
}

const FullAppRuntime = defineAsyncComponent(() => import('@/components/runtime/AppRuntime.vue'))

function renderFullAppComposition(content: VNode): VNode {
  return h(Fragment, null, [
    content,
    runtimeActive.value ? h(FullAppRuntime) : null
  ])
}

const FullAppCompositionRoot = defineComponent({
  name: 'FullAppCompositionRoot',
  setup() {
    return () => renderFullAppComposition(h(App))
  }
})

export type FullAppNavigationIntent = Readonly<{
  to: string
  replace?: boolean
}>

export type CommitPreparedFullAppOptions = Readonly<{
  navigationIntent?: FullAppNavigationIntent
  routeReadinessTimeoutMs?: number
}>

type AppRouter = ReturnType<typeof createAppRouter>

export type PreparedFullApp = Readonly<{
  app: ReturnType<typeof createApp>
  pinia: ReturnType<typeof createPinia>
  head: ReturnType<typeof createHead>
  router: AppRouter
  options: BootstrapFullAppOptions
  isPublicShellTakeover: boolean
  isDirectSpaBootstrap: boolean
  publicTakeover: PublicHydrationTakeoverHandle | null
}>

let bootstrapPromise: Promise<AppRouter> | null = null
let deferredMotionInstallStarted = false
let router: AppRouter

function ensureAppRouter(options: BootstrapFullAppOptions): AppRouter {
  router ??= createAppRouter({
    prepareLocaleDomains: beginLocaleRouteTransaction,
    prewarmPublicRoute,
    getPublicActivationOwner: options.getPublicActivationOwner ?? (() => 'full-app')
  })
  return router
}

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

async function prepareInitialLocaleForFullApp(options: BootstrapFullAppOptions): Promise<void> {
  const appRouter = ensureAppRouter(options)
  const route = appRouter.resolve(readCurrentBrowserRoute())
  const takeoverLocale = options.takeover === 'public-shell'
    ? getPublicHydrationTakeoverHandle()?.payload.renderLocale
    : undefined
  await activateLocaleRuntime(
    isSupportedLocale(takeoverLocale) ? takeoverLocale : undefined,
    requiredLocaleDomainsForRoute(route)
  )
}

async function syncRouterToCurrentLocationForClientMount(): Promise<void> {
  const targetRoute = readCurrentBrowserRoute()
  if (router.currentRoute.value.fullPath === targetRoute) {
    return
  }

  await router.replace(targetRoute).catch((e: unknown) => {
    if (import.meta.env.DEV) { console.warn('[fullApp] router.replace failed', e) }
  })
}

function installFullAppPlugins(prepared: PreparedFullApp): void {
  const { app, pinia, head, router: preparedRouter } = prepared

  // FsusUI 1.4 MessageBox reads `center` during its initial render before
  // programmatic options are copied onto the instance.
  app.config.globalProperties.center = false

  app.use(head)
  if (!prepared.isPublicShellTakeover) {
    pinia.use(piniaPluginPersistedstate)
    app.use(pinia)
  }
  app.use(preparedRouter)
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
      return renderFullAppComposition(h(App))
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
      spaSearch: runtimeActive.value
    })

    return renderFullAppComposition(h(PublicBlogLayoutShell, {
      ...shellState,
      spaNavigation: true,
      onNavigate: handleNavigate,
      onSearch: handleSearch,
      onSearchFocus: handleSearchFocus
    }, {
      default: renderPublicRouteComponent
    }))
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
      .catch((e: unknown) => {
        deferredMotionInstallStarted = false
        if (import.meta.env.DEV) { console.warn('[fullApp] motion install failed', e) }
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
    app: publicTakeover?.app ?? createApp(FullAppCompositionRoot),
    pinia: publicTakeover?.pinia ?? createPinia(),
    head: createHead(),
    router: ensureAppRouter(options),
    options,
    isPublicShellTakeover,
    isDirectSpaBootstrap,
    publicTakeover
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
): Promise<AppRouter> {
  try {
    const visualGuard = prepared.isPublicShellTakeover
      ? beginPublicTakeoverVisualGuard({
          navigationId: resolvePublicTakeoverNavigationId(options),
          timeoutMs: options.routeReadinessTimeoutMs ?? DEFAULT_PUBLIC_TAKEOVER_ROUTE_READY_TIMEOUT_MS
        })
      : null

    if (prepared.isPublicShellTakeover) {
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
    // Composition root owns runtime policy after FullApp is interactive:
    // public takeover inherits the first intent; direct SPA uses after-first-paint.
    if (prepared.isPublicShellTakeover) {
      scheduleRuntimeActivation('takeover')
    } else {
      scheduleRuntimeActivation('after-first-paint')
    }
    installDeferredFsusMotion(prepared)
    scheduleNonCriticalResources()

    await router.isReady()
    await replayNavigationIntent(options.navigationIntent)
    await waitForPublicTakeoverVisualReady(visualGuard)
    markStartup('full-app-bootstrap:router-ready')
    if (!prepared.isPublicShellTakeover) {
      markDirectPublicShellReady()
    }
    measureStartup('full-app-bootstrap', 'full-app-bootstrap:start', 'full-app-bootstrap:mounted')
    measureStartup('router-ready-after-mount', 'full-app-bootstrap:mounted', 'full-app-bootstrap:router-ready')
    removeGlobalLoader()
    return router
  } catch (error) {
    throw error
  }
}

export function bootstrapFullApp(options?: BootstrapFullAppOptions): Promise<AppRouter> {
  if (bootstrapPromise) {
    return bootstrapPromise
  }

  bootstrapPromise = (async () => {
    await prepareInitialLocaleForFullApp(options ?? {})
    const prepared = prepareFullApp(options)
    return await commitPreparedFullApp(prepared)
  })().catch((error) => {
    bootstrapPromise = null
    throw error
  })

  return bootstrapPromise
}
