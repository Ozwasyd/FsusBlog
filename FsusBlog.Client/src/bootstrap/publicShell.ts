import { enableFullAppRuntime, runtimePhase, runtimeReady } from '@/bootstrap/runtimeGate'
import { readPublicHydrationPayload } from '@/bootstrap/publicHydrationBootstrap'
import type { PublicHydrationPayload } from '@/public-renderers'
import type { Router } from 'vue-router'
import {
  isPublicSeoPath,
  removeGlobalLoader
} from '@/bootstrap/publicShellPrimitives'

function isModifiedEvent(event: MouseEvent): boolean {
  return event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

function isInternalAppLink(anchor: HTMLAnchorElement): boolean {
  if (anchor.target && anchor.target !== '_self') {
    return false
  }

  if (anchor.hasAttribute('download')) {
    return false
  }

  const rawHref = anchor.getAttribute('href')
  if (!rawHref || rawHref.startsWith('#')) {
    return false
  }

  const url = new URL(anchor.href, window.location.origin)
  if (url.origin !== window.location.origin) {
    return false
  }

  if (url.pathname.startsWith('/api/')) {
    return false
  }

  return true
}

function dispatchAotAction(actionNode: HTMLElement): void {
  const action = actionNode.dataset.aotAction
  if (!action) {
    return
  }

  const rawValue = Number(actionNode.dataset.aotValue ?? actionNode.dataset.aotId ?? '0')
  const safeValue = Number.isFinite(rawValue) ? Math.trunc(rawValue) : 0
  const key = actionNode.dataset.aotKey

  window.dispatchEvent(new CustomEvent('fsus:aot:event', {
    detail: {
      action,
      value: safeValue,
      key
    }
  }))
}

type CriticalStyleLink = {
  key: string
  href: string
  marker: string
}

const CRITICAL_STYLE_FALLBACKS: CriticalStyleLink[] = [
  {
    key: 'public-critical',
    href: import.meta.env.DEV ? '/src/assets/critical-public.css?direct' : '/src/assets/critical-public.css',
    marker: 'critical-public.css'
  },
  {
    key: 'app-main',
    href: import.meta.env.DEV ? '/src/assets/main.css?direct' : '/src/assets/main.css',
    marker: 'main.css'
  }
]

function isFontOnlyStylesheet(link: HTMLLinkElement): boolean {
  const href = (link.getAttribute('href') ?? '').toLowerCase()
  const marker = (link.dataset.fsusStyle ?? '').toLowerCase()
  return marker.includes('font') || href.includes('font')
}

function isRenderableStylesheet(link: HTMLLinkElement): boolean {
  const rel = (link.getAttribute('rel') ?? '').toLowerCase()
  if (rel !== 'stylesheet') {
    return false
  }

  if ((link.getAttribute('disabled') ?? '') === 'true' || link.disabled) {
    return false
  }

  return !isFontOnlyStylesheet(link)
}

function listRenderableStylesheets(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .filter((link) => isRenderableStylesheet(link))
}

function dedupeStylesheetLinks(links: HTMLLinkElement[]): HTMLLinkElement[] {
  const seen = new Set<string>()
  const ordered: HTMLLinkElement[] = []
  for (const link of links) {
    const key = link.dataset.fsusStyle?.trim() || link.getAttribute('href') || ''
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    ordered.push(link)
  }
  return ordered
}

function ensureFallbackStylesheets(): HTMLLinkElement[] {
  const head = document.head ?? document.getElementsByTagName('head')[0]
  if (!head) {
    return []
  }

  const presentLinks = listRenderableStylesheets()
  const requiredLinks = CRITICAL_STYLE_FALLBACKS.map((candidate) => {
    const existing = document.querySelector<HTMLLinkElement>(
      `link[rel="stylesheet"][data-fsus-style="${candidate.key}"]`
    )
    if (existing) {
      return existing
    }

    const byHref = document.querySelector<HTMLLinkElement>(
      `link[rel="stylesheet"][href*="${candidate.marker}"]`
    )
    if (byHref) {
      return byHref
    }

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = candidate.href
    link.dataset.fsusStyle = candidate.key
    link.dataset.fsusInjected = 'bootstrap'
    head.appendChild(link)
    return link
  })

  return dedupeStylesheetLinks([...presentLinks, ...requiredLinks])
}

function waitForStylesheet(link: HTMLLinkElement, timeoutMs = 1500): Promise<boolean> {
  if (link.sheet) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false

    const onLoad = () => complete(true)
    const onError = () => complete(false)

    const complete = (loaded: boolean) => {
      if (settled) {
        return
      }
      settled = true
      link.removeEventListener('load', onLoad)
      link.removeEventListener('error', onError)
      resolve(loaded || Boolean(link.sheet))
    }

    link.addEventListener('load', onLoad, { once: true })
    link.addEventListener('error', onError, { once: true })
    window.setTimeout(() => complete(false), timeoutMs)
  })
}

function ensureEmergencyPublicShellStyle(): void {
  const styleId = 'fsus-public-emergency-style'
  if (document.getElementById(styleId)) {
    return
  }

  const style = document.createElement('style')
  style.id = styleId
  style.textContent = `
#fsus-aot-shell{font-family:var(--font-sans,"Google Sans","Noto Sans SC","Noto Sans TC","Noto Sans JP",ui-sans-serif,system-ui,sans-serif);background:#fff;color:#09090b;line-height:1.6}
#fsus-aot-shell a{color:#27272a;text-decoration:none}
#fsus-aot-shell .mono-link,#fsus-aot-shell .active-link{font-size:.875rem}
#fsus-aot-shell .active-link{color:#09090b;font-weight:700}
#fsus-aot-shell .ui-article-card{display:flex;flex-direction:column;gap:.75rem}
#fsus-aot-shell .ui-article-title{font-size:1.35rem;line-height:1.3;font-weight:700;color:#09090b}
#fsus-aot-shell .ui-article-summary{font-size:.96rem;line-height:1.75;color:#52525b}
#fsus-aot-shell .ui-pagination{display:flex;align-items:center;justify-content:space-between;margin-top:2rem;padding-top:1rem;border-top:1px solid #f4f4f5}
#fsus-aot-shell [data-aot-action="page-prev"],#fsus-aot-shell [data-aot-action="page-next"]{background:transparent;border:0;color:#52525b;font-size:.75rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
`
  document.head.appendChild(style)
}

export async function ensurePublicShellStylesReady(): Promise<void> {
  if (typeof document === 'undefined') {
    return
  }

  const styleLinks = ensureFallbackStylesheets()
  if (styleLinks.length === 0) {
    ensureEmergencyPublicShellStyle()
    return
  }

  const loadedStates = await Promise.all(styleLinks.map((link) => waitForStylesheet(link)))
  const hasRenderableSheet = listRenderableStylesheets().some((link) => Boolean(link.sheet))
  if (!hasRenderableSheet || loadedStates.every((loaded) => !loaded)) {
    ensureEmergencyPublicShellStyle()
  }
}

let bootPromise: Promise<Router> | null = null
let fullAppModulePromise: Promise<typeof import('@/bootstrap/fullApp')> | null = null
let preBootstrapNavigationBound = false
let runtimeHintToast: { close: () => Promise<void>; setMessage: (message: string) => void } | null = null
let hydratedPayload: PublicHydrationPayload | null = null

function createPublicRuntimeToast(message: string): { close: () => Promise<void>; setMessage: (message: string) => void } {
  const rootId = 'fsus-public-runtime-hint-root'
  let root = document.getElementById(rootId)
  if (!root) {
    root = document.createElement('div')
    root.id = rootId
    root.className = 'fixed inset-x-0 top-0 z-[9999] pointer-events-none flex justify-center px-4 pt-2 sm:pt-3'
    document.body.appendChild(root)
  }

  const container = document.createElement('div')
  container.style.opacity = '0'
  container.style.transition = 'opacity 160ms ease'
  container.style.width = '54px'
  container.style.height = '3px'
  container.style.borderRadius = '999px'
  container.style.background = 'rgba(113, 113, 122, 0.2)'
  container.style.boxShadow = '0 0 0 1px rgba(113, 113, 122, 0.12)'
  container.setAttribute('role', 'status')
  container.setAttribute('aria-live', 'polite')
  container.setAttribute('aria-atomic', 'true')
  container.setAttribute('aria-label', message)

  root.appendChild(container)

  const showDelayMs = 220
  const minVisibleMs = 420
  const fadeOutMs = 160
  const showTimer = window.setTimeout(() => {
    requestAnimationFrame(() => {
      container.style.opacity = '1'
    })
  }, showDelayMs)

  let shownAt = 0
  let open = true
  const onShown = () => {
    shownAt = Date.now()
  }
  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.propertyName === 'opacity' && container.style.opacity === '1') {
      onShown()
    }
  }
  container.addEventListener('transitionend', onTransitionEnd)

  let destroyed = false
  const destroy = () => {
    if (destroyed) {
      return
    }
    destroyed = true
    container.removeEventListener('transitionend', onTransitionEnd)
    window.clearTimeout(showTimer)
    container.remove()
    if (root && root.childElementCount === 0) {
      root.remove()
    }
  }

  return {
    setMessage: (nextMessage: string) => {
      container.setAttribute('aria-label', nextMessage)
    },
    close: async () => {
      if (!open) {
        return
      }

      open = false
      window.clearTimeout(showTimer)
      const elapsed = shownAt > 0 ? Date.now() - shownAt : 0
      const waitMs = shownAt > 0 ? Math.max(0, minVisibleMs - elapsed) : 0
      if (waitMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, waitMs))
      }
      container.style.opacity = '0'
      await new Promise((resolve) => window.setTimeout(resolve, fadeOutMs))
      destroy()
    }
  }
}

async function showPublicRuntimeHint(message = '正在切换到交互模式'): Promise<void> {
  if (runtimeReady.value) {
    return
  }

  if (runtimeHintToast) {
    runtimeHintToast.setMessage(message)
    return
  }
  runtimeHintToast = createPublicRuntimeToast(message)
}

function hidePublicRuntimeHint(): void {
  const activeHint = runtimeHintToast
  runtimeHintToast = null
  if (!activeHint) {
    return
  }
  void activeHint.close()
}

function clearPublicFirstPaintFlag(): void {
  document.body.removeAttribute('data-fsus-public-first-paint')
}

function shouldUseDocumentNavigation(href: string): boolean {
  const target = new URL(href, window.location.origin)
  return isPublicSeoPath(target.pathname)
}

function navigateWithDocumentRequest(href: string): void {
  window.location.assign(href)
}

function resolveShellActionNavigation(actionNode: HTMLElement): string | null {
  const action = actionNode.dataset.aotAction
  if (action !== 'page-prev' && action !== 'page-next') {
    return null
  }

  if (hydratedPayload?.pageKind === 'Home') {
    const step = action === 'page-prev' ? -1 : 1
    const nextPage = hydratedPayload.currentPage + step
    const totalPages = Math.max(1, Math.ceil(hydratedPayload.total / Math.max(1, hydratedPayload.pageSize)))
    if (nextPage < 1 || nextPage > totalPages) {
      return null
    }

    const target = new URL(window.location.href)
    if (nextPage <= 1) {
      target.searchParams.delete('page')
    } else {
      target.searchParams.set('page', String(nextPage))
    }

    return target.toString()
  }

  const pathname = window.location.pathname
  const isFilterSeoPath = /^\/(category|tag)\/\d+\/?$/.test(pathname)
  if (!isFilterSeoPath) {
    return null
  }

  const target = new URL(window.location.href)
  const currentPageRaw = Number(target.searchParams.get('page') ?? '1')
  const currentPage = Number.isFinite(currentPageRaw) && currentPageRaw > 0 ? Math.trunc(currentPageRaw) : 1
  const step = action === 'page-prev' ? -1 : 1
  const nextPage = currentPage + step
  if (nextPage < 1) {
    return null
  }

  if (nextPage <= 1) {
    target.searchParams.delete('page')
  } else {
    target.searchParams.set('page', String(nextPage))
  }

  return target.toString()
}

async function bootFullAppForNavigation(targetHref?: string): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const { bootstrapFullApp } = await preloadFullAppModule()
      return bootstrapFullApp({ deferRuntime: true, hydrate: true })
    })()
  }

  const router = await bootPromise
  if (targetHref) {
    const target = new URL(targetHref, window.location.origin)
    const fullPath = `${target.pathname}${target.search}${target.hash}`
    if (router.currentRoute.value.fullPath !== fullPath) {
      await router.push(fullPath)
    }

    requestAnimationFrame(() => {
      clearPublicFirstPaintFlag()
      hidePublicRuntimeHint()
    })
    return
  }

  requestAnimationFrame(() => {
    clearPublicFirstPaintFlag()
  })
}

function bindPreBootstrapNavigation(): void {
  if (preBootstrapNavigationBound) {
    return
  }

  preBootstrapNavigationBound = true
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || isModifiedEvent(event)) {
      return
    }

    const actionNode = event.target.closest('[data-aot-action]')
    if (actionNode instanceof HTMLElement && !actionNode.hasAttribute('disabled')) {
      const anchor = actionNode.closest('a')

      const actionHref = resolveShellActionNavigation(actionNode)
      if (actionHref) {
        event.preventDefault()
        navigateWithDocumentRequest(actionHref)
        return
      }

      if (anchor instanceof HTMLAnchorElement && isInternalAppLink(anchor) && shouldUseDocumentNavigation(anchor.href)) {
        return
      }

      event.preventDefault()
      if (!runtimeReady.value) {
        runtimePhase.value = 'runtime-loading'
        void showPublicRuntimeHint()
      }
      enableFullAppRuntime()

      if (anchor instanceof HTMLAnchorElement && isInternalAppLink(anchor)) {
        void bootFullAppForNavigation(anchor.href).finally(() => {
          hidePublicRuntimeHint()
        })
        return
      }

      void bootFullAppForNavigation().then(() => {
        dispatchAotAction(actionNode)
      }).finally(() => {
        hidePublicRuntimeHint()
      })
      return
    }

    const anchor = event.target.closest('a')
    if (!(anchor instanceof HTMLAnchorElement) || !isInternalAppLink(anchor)) {
      return
    }

    if (shouldUseDocumentNavigation(anchor.href)) {
      return
    }

    event.preventDefault()
    if (!runtimeReady.value) {
      runtimePhase.value = 'runtime-loading'
      void showPublicRuntimeHint()
    }
    enableFullAppRuntime()
    void bootFullAppForNavigation(anchor.href).finally(() => {
      hidePublicRuntimeHint()
    })
  }, { passive: false })
}

function preloadFullAppModule(): Promise<typeof import('@/bootstrap/fullApp')> {
  if (!fullAppModulePromise) {
    fullAppModulePromise = import('@/bootstrap/fullApp')
  }

  return fullAppModulePromise
}

function scheduleFullAppModuleWarmup(): void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  }

  const warmup = () => {
    void preloadFullAppModule().catch(() => {})
  }

  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(() => warmup(), { timeout: 2500 })
    return
  }

  window.setTimeout(warmup, 700)
}

function hydratePublicShell(): Promise<void> {
  return Promise.resolve().then(() => {
    const payload = readPublicHydrationPayload()
    if (!payload) {
      return
    }
    hydratedPayload = payload
  })
}

function scheduleAutoFullAppHydration(): void {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  }

  const run = () => {
    if (runtimeReady.value) {
      return
    }

    runtimePhase.value = 'runtime-loading'
    enableFullAppRuntime()
    void bootFullAppForNavigation().finally(() => {
      hidePublicRuntimeHint()
    })
  }

  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleWindow.requestIdleCallback(() => run(), { timeout: 1800 })
    return
  }

  window.setTimeout(run, 700)
}

export async function bootstrapPublicShell(): Promise<void> {
  document.body.setAttribute('data-fsus-public-first-paint', 'true')
  const hydrateTask = hydratePublicShell()
  scheduleFullAppModuleWarmup()

  await ensurePublicShellStylesReady()
  removeGlobalLoader()

  try {
    await hydrateTask
  } catch (error) {
    console.warn('[public-shell] hydration payload init failed, fallback to full-app boot', error)
  } finally {
    // Always bind intent bridge and schedule background runtime load,
    // even when hydration payload is malformed or temporarily missing.
    bindPreBootstrapNavigation()
    scheduleAutoFullAppHydration()
  }
}
