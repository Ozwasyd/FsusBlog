/**
 * Browser harness for public bootstrap causal matrix evidence.
 * Uses telemetry receipts, PerformanceResourceTiming, and DOM mutation logs.
 * Never uses fixed multi-second sleeps as readiness oracles.
 */
import type { Page, Route } from '@playwright/test'
import {
  createEmptyPublicBootstrapCausalEvidence,
  requirePublicBootstrapCausalOrder
} from '../publicBootstrapCausalEvidence.mjs'

export type PublicBootstrapCausalEvidence = ReturnType<typeof createEmptyPublicBootstrapCausalEvidence>

export type DelayPlan = Readonly<{
  spaEntryMs?: number
  fullAppCoreMs?: number
  publicRouteChunkMs?: number
  navigationSnapshotMs?: number
  failSpaEntry?: boolean
  failNavigationSnapshot?: boolean
}>

export type CausalProbe = {
  evidence: PublicBootstrapCausalEvidence
  dispose: () => Promise<void>
  markIntent: () => Promise<void>
  snapshotEvidence: () => Promise<PublicBootstrapCausalEvidence>
  assertCausalOrder: () => Promise<void>
  counts: () => Promise<{
    navigationSnapshotRequests: number
    spaEntryRequests: number
    nprogressEverVisible: boolean
    loaderEverVisible: boolean
    documentNavigations: number
  }>
}

function isSpaEntryUrl(url: string): boolean {
  return /fsus-spa-entry|\/src\/bootstrap\/entry\.(ts|js)|\/assets\/entry/i.test(url)
}

function isFullAppCoreUrl(url: string): boolean {
  return /bootstrap\/fullApp|full-app|entry-runtime|\/src\/bootstrap\/fullApp/i.test(url)
}

function isPublicRouteChunkUrl(url: string): boolean {
  return /Archive|About|public-renderers|views\/public|route.*archive/i.test(url)
    && /\.(js|ts|mjs)(\?|$)/i.test(url)
}

function isNavigationSnapshotUrl(url: string): boolean {
  return url.includes('/api/public/navigation-snapshot.aeds')
    || url.includes('navigation-snapshot.aeds')
}

export async function installPublicBootstrapCausalProbe(
  page: Page,
  options: Readonly<{ route: string, scenario: string, delay?: DelayPlan }>
): Promise<CausalProbe> {
  const delay = options.delay ?? {}
  const counters = {
    navigationSnapshotRequests: 0,
    spaEntryRequests: 0,
    documentNavigations: 0
  }

  await page.addInitScript(() => {
    const w = window as Window & {
      __FSUS_PUBLIC_BOOTSTRAP_CAUSAL__?: {
        intentAt: number | null
        feedbackFirstVisible: number | null
        feedbackHidden: number | null
        interactiveAt: number | null
        fallbackAt: number | null
        commitStart: number | null
        coreStart: number | null
        coreEnd: number | null
        componentStart: number | null
        componentEnd: number | null
        snapshotStart: number | null
        snapshotEnd: number | null
        entryStart: number | null
        entryEnd: number | null
        loaderEverVisible: boolean
        nprogressEverVisible: boolean
        navigationCount: number
        telemetry: Array<{ name: string, at: number, detail?: Record<string, unknown> }>
      }
    }

    const state = {
      intentAt: null as number | null,
      feedbackFirstVisible: null as number | null,
      feedbackHidden: null as number | null,
      interactiveAt: null as number | null,
      fallbackAt: null as number | null,
      commitStart: null as number | null,
      coreStart: null as number | null,
      coreEnd: null as number | null,
      componentStart: null as number | null,
      componentEnd: null as number | null,
      snapshotStart: null as number | null,
      snapshotEnd: null as number | null,
      entryStart: null as number | null,
      entryEnd: null as number | null,
      loaderEverVisible: false,
      nprogressEverVisible: false,
      navigationCount: 0,
      telemetry: [] as Array<{ name: string, at: number, detail?: Record<string, unknown> }>
    }
    w.__FSUS_PUBLIC_BOOTSTRAP_CAUSAL__ = state

    const now = () => performance.now()

    const observeLoader = () => {
      const loader = document.getElementById('global-loader')
      if (loader && !loader.hidden && loader.getAttribute('aria-hidden') !== 'true') {
        state.loaderEverVisible = true
        if (state.feedbackFirstVisible === null) {
          state.feedbackFirstVisible = now()
        }
      } else if (state.feedbackFirstVisible !== null && state.feedbackHidden === null) {
        const node = document.getElementById('global-loader')
        if (!node || node.hidden || node.getAttribute('aria-hidden') === 'true') {
          state.feedbackHidden = now()
        }
      }
      const nprogress = document.getElementById('nprogress')
      if (nprogress && getComputedStyle(nprogress).display !== 'none') {
        state.nprogressEverVisible = true
      }
    }

    const mo = new MutationObserver(() => observeLoader())
    const start = () => {
      mo.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'class', 'style']
      })
      observeLoader()
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true })
    } else {
      start()
    }

    window.addEventListener('fsus:telemetry', ((event: Event) => {
      const detail = (event as CustomEvent).detail as {
        name?: string
        detail?: Record<string, unknown>
      } | undefined
      if (!detail?.name) return
      const at = now()
      state.telemetry.push({ name: detail.name, at, detail: detail.detail })
      if (detail.name === 'public_activation_phase') {
        const to = detail.detail?.to
        if (to === 'committing' && state.commitStart === null) state.commitStart = at
        if (to === 'interactive' && state.interactiveAt === null) state.interactiveAt = at
        if (to === 'fallback' && state.fallbackAt === null) state.fallbackAt = at
        if (to === 'foreground-wait' && state.intentAt === null) state.intentAt = at
      }
      if (detail.name === 'public_activation_terminal') {
        const status = detail.detail?.status
        if (status === 'interactive' && state.interactiveAt === null) state.interactiveAt = at
        if (status === 'fallback' && state.fallbackAt === null) state.fallbackAt = at
      }
      if (detail.name === 'public_activation_prepare_timing') {
        if (state.coreEnd === null) state.coreEnd = at
        if (state.componentEnd === null) state.componentEnd = at
        if (state.snapshotEnd === null) state.snapshotEnd = at
      }
      if (detail.name === 'public_route_prewarm_start') {
        if (state.componentStart === null) state.componentStart = at
        if (state.snapshotStart === null) state.snapshotStart = at
      }
    }) as EventListener)

    const pushState = history.pushState.bind(history)
    const replaceState = history.replaceState.bind(history)
    history.pushState = function patchedPushState(...args) {
      state.navigationCount += 1
      return pushState(...args)
    }
    history.replaceState = function patchedReplaceState(...args) {
      // replaceState is used for locale/query housekeeping; count only path changes.
      try {
        const url = args[2]
        if (typeof url === 'string') {
          const next = new URL(url, location.href)
          if (next.pathname !== location.pathname) state.navigationCount += 1
        }
      } catch {
        // ignore
      }
      return replaceState(...args)
    }
  })

  const routeHandler = async (route: Route) => {
    const url = route.request().url()
    const wait = async (ms: number | undefined) => {
      if (ms && ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, ms))
      }
    }

    if (isSpaEntryUrl(url)) {
      counters.spaEntryRequests += 1
      if (delay.failSpaEntry) {
        await route.abort('failed')
        return
      }
      await wait(delay.spaEntryMs)
      await route.continue()
      return
    }
    if (isFullAppCoreUrl(url)) {
      await wait(delay.fullAppCoreMs)
      await route.continue()
      return
    }
    if (isPublicRouteChunkUrl(url)) {
      await wait(delay.publicRouteChunkMs)
      await route.continue()
      return
    }
    if (isNavigationSnapshotUrl(url)) {
      counters.navigationSnapshotRequests += 1
      if (delay.failNavigationSnapshot) {
        await route.fulfill({ status: 503, body: 'snapshot-unavailable' })
        return
      }
      await wait(delay.navigationSnapshotMs)
      await route.continue()
      return
    }
    await route.continue()
  }

  await page.route('**/*', routeHandler)

  // Counts are owned by the route handler above to avoid double counting.
  const onFrameNavigated = () => {
    counters.documentNavigations += 1
  }

  page.on('framenavigated', onFrameNavigated)

  const evidence = createEmptyPublicBootstrapCausalEvidence({
    route: options.route,
    scenario: options.scenario
  })

  return {
    evidence,
    async dispose() {
      page.off('framenavigated', onFrameNavigated)
      await page.unroute('**/*', routeHandler)
    },
    async markIntent() {
      await page.evaluate(() => {
        const state = (window as Window & {
          __FSUS_PUBLIC_BOOTSTRAP_CAUSAL__?: { intentAt: number | null }
        }).__FSUS_PUBLIC_BOOTSTRAP_CAUSAL__
        if (state && state.intentAt === null) {
          state.intentAt = performance.now()
        }
      })
    },
    async snapshotEvidence() {
      const remote = await page.evaluate(() => {
        const state = (window as Window & {
          __FSUS_PUBLIC_BOOTSTRAP_CAUSAL__?: Record<string, unknown>
        }).__FSUS_PUBLIC_BOOTSTRAP_CAUSAL__
        const buildIdentity = document
          .getElementById('fsus-public-boot-config')
          ?.textContent
        let parsedIdentity: string | null = null
        try {
          if (buildIdentity) {
            parsedIdentity = JSON.parse(buildIdentity).frontendBuildIdentity ?? null
          }
        } catch {
          parsedIdentity = null
        }
        const shell = document.querySelector('#fsus-aot-shell')
        const loader = document.getElementById('global-loader')
        const nprogress = document.getElementById('nprogress')
        return {
          state,
          buildIdentity: parsedIdentity,
          hydrated: shell?.getAttribute('data-public-hydrated') === 'true',
          loaderVisible: Boolean(loader && !loader.hidden),
          nprogressPresent: Boolean(nprogress),
          pathname: location.pathname
        }
      })

      const state = (remote.state ?? {}) as {
        intentAt?: number | null
        feedbackFirstVisible?: number | null
        feedbackHidden?: number | null
        interactiveAt?: number | null
        fallbackAt?: number | null
        commitStart?: number | null
        coreStart?: number | null
        coreEnd?: number | null
        componentStart?: number | null
        componentEnd?: number | null
        snapshotStart?: number | null
        snapshotEnd?: number | null
        entryStart?: number | null
        entryEnd?: number | null
        loaderEverVisible?: boolean
        nprogressEverVisible?: boolean
        navigationCount?: number
      }

      evidence.buildIdentity = remote.buildIdentity
      evidence.timestamps.intent = state.intentAt ?? evidence.timestamps.intent
      evidence.timestamps.feedbackFirstVisible = state.feedbackFirstVisible ?? null
      evidence.timestamps.feedbackHidden = state.feedbackHidden ?? null
      evidence.timestamps.interactive = state.interactiveAt ?? null
      evidence.timestamps.fallback = state.fallbackAt ?? null
      evidence.timestamps.commitStart = state.commitStart ?? null
      evidence.timestamps.coreStart = state.coreStart ?? null
      evidence.timestamps.coreEnd = state.coreEnd ?? null
      evidence.timestamps.componentStart = state.componentStart ?? null
      evidence.timestamps.componentEnd = state.componentEnd ?? null
      evidence.timestamps.snapshotStart = state.snapshotStart ?? null
      evidence.timestamps.snapshotEnd = state.snapshotEnd ?? null
      evidence.timestamps.entryStart = state.entryStart ?? null
      evidence.timestamps.entryEnd = state.entryEnd ?? null
      evidence.navigationCount = state.navigationCount ?? 0
      evidence.documentNavigationCount = counters.documentNavigations
      evidence.overlayFinalCount = remote.loaderVisible ? 1 : 0
      return evidence
    },
    async assertCausalOrder(this: CausalProbe) {
      const current = await this.snapshotEvidence()
      requirePublicBootstrapCausalOrder(current, options.scenario)
    },
    async counts() {
      const remote = await page.evaluate(() => {
        const state = (window as Window & {
          __FSUS_PUBLIC_BOOTSTRAP_CAUSAL__?: {
            loaderEverVisible?: boolean
            nprogressEverVisible?: boolean
          }
        }).__FSUS_PUBLIC_BOOTSTRAP_CAUSAL__
        return {
          loaderEverVisible: Boolean(state?.loaderEverVisible),
          nprogressEverVisible: Boolean(state?.nprogressEverVisible)
        }
      })
      return {
        navigationSnapshotRequests: counters.navigationSnapshotRequests,
        spaEntryRequests: counters.spaEntryRequests,
        nprogressEverVisible: remote.nprogressEverVisible,
        loaderEverVisible: remote.loaderEverVisible,
        documentNavigations: counters.documentNavigations
      }
    }
  }
}

export async function waitForActivationTerminal(
  page: Page,
  {
    timeoutMs = 45_000
  }: { timeoutMs?: number } = {}
): Promise<'interactive' | 'fallback' | 'unknown'> {
  try {
    await page.waitForFunction(() => {
      const state = (window as Window & {
        __FSUS_PUBLIC_BOOTSTRAP_CAUSAL__?: {
          interactiveAt: number | null
          fallbackAt: number | null
        }
      }).__FSUS_PUBLIC_BOOTSTRAP_CAUSAL__
      if (state?.interactiveAt != null || state?.fallbackAt != null) return true
      return document.querySelector('#fsus-aot-shell')
        ?.getAttribute('data-public-hydrated') === 'true'
    }, undefined, { timeout: timeoutMs })
  } catch {
    return 'unknown'
  }

  return page.evaluate(() => {
    const state = (window as Window & {
      __FSUS_PUBLIC_BOOTSTRAP_CAUSAL__?: {
        interactiveAt: number | null
        fallbackAt: number | null
      }
    }).__FSUS_PUBLIC_BOOTSTRAP_CAUSAL__
    if (state?.interactiveAt != null) return 'interactive'
    if (state?.fallbackAt != null) return 'fallback'
    if (document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated') === 'true') {
      return 'interactive'
    }
    return 'unknown'
  })
}

export async function clickPublicNav(page: Page, name: string | RegExp): Promise<void> {
  const links = page
    .locator('nav[aria-label="主导航"], nav[aria-label="Primary navigation"]')
    .getByRole('link', { name })
  for (let index = 0; index < await links.count(); index += 1) {
    const candidate = links.nth(index)
    if (await candidate.isVisible()) {
      await candidate.click()
      return
    }
  }
  // Fallback: any visible same-name link in the public shell.
  const any = page.getByRole('link', { name }).first()
  await any.click()
}
