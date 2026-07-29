import { createSSRApp, nextTick, ref, shallowRef, type App as VueApp, type VNode } from 'vue'
import { createPinia, type Pinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { provideFsusUiAppContext } from '@/fsusui/appContext'
import type { PublicHydrationPayload } from './types'
import {
  beginHydrationMetrics,
  finishHydrationMetrics,
  markHydrationStep
} from './hydrationPerf'
import {
  captureHydrationIdentity,
  verifyHydrationIdentity
} from './hydrationIdentityGuard'
import { normalizePublicHydrationPayload } from './publicPayloadNormalizer'
import {
  createPublicHydrationRootComponent,
  renderPublicHydrationMarkdown,
  type PublicHydrationTakeoverController
} from './publicHydrationRoot'
import { registerPublicStaticRouterLink } from './publicStaticRouterLink'
import { activateLocaleRuntime, isSupportedLocale } from '@/locales'
import { requiredLocaleDomainsForPublicPage } from '@/locales/routeLocaleDomains'
import { hasCanonicalPublicSeedRenderTimestamp } from './publicRenderClock'

const APP_SELECTOR = '#app'
const SHELL_SELECTOR = '#fsus-aot-shell'
const HYDRATION_MISMATCH_PATTERN = /hydration|Hydration/u

let mountedPublicShellApp: VueApp<Element> | null = null
let mountedPublicShellPinia: Pinia | null = null
let mountedPublicShellPayload: PublicHydrationPayload | null = null
let publicTakeoverController: PublicHydrationTakeoverController | null = null

export type PublicHydrationTakeoverHandle = Readonly<{
  app: VueApp<Element>
  pinia: Pinia
  payload: PublicHydrationPayload
  activate: (renderer: () => VNode) => Promise<void>
}>

export function getPublicHydrationTakeoverHandle(): PublicHydrationTakeoverHandle | null {
  if (!mountedPublicShellApp || !mountedPublicShellPinia || !mountedPublicShellPayload || !publicTakeoverController) {
    return null
  }

  const controller = publicTakeoverController
  return {
    app: mountedPublicShellApp,
    pinia: mountedPublicShellPinia,
    payload: mountedPublicShellPayload,
    activate: async (renderer: () => VNode): Promise<void> => {
      controller.renderer.value = renderer
      controller.active.value = true
      await nextTick()
    }
  }
}

export function disposePublicHydrationApp(): void {
  if (!mountedPublicShellApp) {
    return
  }

  mountedPublicShellApp.unmount()
  releasePublicHydrationTakeover()
}

/**
 * Drop FullApp/AppRuntime takeover ownership without unmounting.
 * Keeps the AOT/hydrated document readable after a fail-closed hydration identity failure.
 */
function releasePublicHydrationTakeover(): void {
  mountedPublicShellApp = null
  mountedPublicShellPinia = null
  mountedPublicShellPayload = null
  publicTakeoverController = null
}

function installHydrationMismatchTrap(app: VueApp<Element>): () => void {
  const previous = app.config.warnHandler
  let mismatch: Error | null = null

  app.config.warnHandler = (message, instance, trace) => {
    const text = String(message)
    if (HYDRATION_MISMATCH_PATTERN.test(text)) {
      const path = typeof trace === 'string' && trace.trim().length > 0
        ? trace.trim().replace(/\s+/gu, ' ').slice(0, 240)
        : 'unknown'
      mismatch = new Error(`[public-hydrate] hydration mismatch: ${text.slice(0, 200)} path=${path}`)
      return
    }

    if (typeof previous === 'function') {
      previous(message, instance, trace)
    }
  }

  return () => {
    app.config.warnHandler = previous
    if (mismatch) {
      throw mismatch
    }
  }
}

/**
 * Hydration of public shell via the shared public shell factory.
 * SSR and BlogLayout both consume the same shell-state builder, so the hydrated
 * public route tree stays structurally identical across first paint and takeover.
 *
 * Production must not patch SSR DOM or suppress Vue mismatch attributes before
 * compare. Unexpected mismatch/identity failure is fail-closed: no hydrated flag,
 * no FullApp takeover handle, AOT document remains readable.
 */
export async function hydratePublicPage(payload: PublicHydrationPayload): Promise<void> {
  if (!hasCanonicalPublicSeedRenderTimestamp(payload)) {
    throw new Error('public_aot_hydration_render_timestamp_invalid')
  }
  const container = document.querySelector<HTMLElement>(APP_SELECTOR)
  if (!container) {
    return
  }

  const shell = container.querySelector<HTMLElement>(SHELL_SELECTOR)
  if (!shell || shell.dataset.publicHydrationKind !== payload.pageKind) {
    return
  }

  if (!isSupportedLocale(payload.renderLocale)
    || shell.dataset.publicRenderLocale !== payload.renderLocale
    || document.documentElement.lang !== payload.renderLocale) {
    throw new Error('public_aot_hydration_locale_mismatch')
  }

  const guard = captureHydrationIdentity(container, shell, payload)

  const metrics = beginHydrationMetrics(payload)
  markHydrationStep('hydrate:start')

  const normalizedPayload = normalizePublicHydrationPayload(payload)
  const initialRender = await renderPublicHydrationMarkdown(normalizedPayload)
  await activateLocaleRuntime(
    normalizedPayload.renderLocale,
    requiredLocaleDomainsForPublicPage(normalizedPayload.pageKind)
  )
  markHydrationStep('hydrate:component-ready')

  try {
    if (!mountedPublicShellApp) {
      const takeoverController: PublicHydrationTakeoverController = {
        active: ref(false),
        renderer: shallowRef<(() => VNode) | null>(null)
      }
      const app = createSSRApp(createPublicHydrationRootComponent(
        normalizedPayload,
        initialRender,
        takeoverController
      ))
      const pinia = createPinia()
      pinia.use(piniaPluginPersistedstate)
      app.use(pinia)
      provideFsusUiAppContext(app)
      registerPublicStaticRouterLink(app)
      const finishMismatchTrap = installHydrationMismatchTrap(app)
      try {
        app.mount(container, true)
        await nextTick()
        finishMismatchTrap()
      } catch (error) {
        releasePublicHydrationTakeover()
        throw error
      }
      mountedPublicShellApp = app
      mountedPublicShellPinia = pinia
      mountedPublicShellPayload = normalizedPayload
      publicTakeoverController = takeoverController
    }

    verifyHydrationIdentity({
      appSelector: APP_SELECTOR,
      shellSelector: SHELL_SELECTOR,
      payload: normalizedPayload,
      guard
    })
    shell.dataset.publicHydrated = 'true'
    markHydrationStep('hydrate:mounted')
    finishHydrationMetrics(metrics)
  } catch (error) {
    // Fail-closed: never claim hydration success or expose FullApp takeover.
    delete shell.dataset.publicHydrated
    releasePublicHydrationTakeover()
    throw error
  }
}
