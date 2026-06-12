import { readPublicHydrationPayload, replacePublicHydrationPayloadBinary } from '@/bootstrap/publicHydrationBootstrap'
import { hydratePublicPage, type PublicHydrationPayload } from '@/public-renderers'
import {
  isPublicSeoPath,
  removeGlobalLoader
} from '@/bootstrap/publicShellPrimitives'
import { emitRumMetric, emitTelemetry } from '@/services/telemetryBus'
import { ensureThemeRuntime, setThemeMode, type ThemeMode } from '@/services/themeRuntime'
import { mountHomeHotArticlesIsland, unmountHomeHotArticlesIsland } from '@/public-renderers/homeHotArticlesIsland'
import { bootstrapFullApp } from '@/bootstrap/fullApp'
import { AEDS_BINARY_MEDIA_TYPE } from '@/api/contracts'
import { getPrefersReducedMotion, resolveMotionScrollBehavior } from '@/composables/useMotionPreference'

function isModifiedEvent(event: MouseEvent): boolean {
  return event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

function resolveHashTarget(hash: string): HTMLElement | null {
  if (!hash || hash === '#') {
    return null
  }

  const rawId = hash.slice(1)
  const id = (() => {
    try {
      return decodeURIComponent(rawId)
    } catch {
      return rawId
    }
  })()

  const byId = document.getElementById(id)
  if (byId) {
    return byId
  }

  const named = document.getElementsByName(id)[0]
  return named instanceof HTMLElement ? named : null
}

function scrollToHashOrTop(href: string): void {
  const url = new URL(href, window.location.origin)
  const target = resolveHashTarget(url.hash)
  if (!target) {
    window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
    return
  }

  window.scrollTo({
    left: 0,
    top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - 88),
    behavior: resolveMotionScrollBehavior(getPrefersReducedMotion())
  })
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
  href: string | null
  marker: string
  readiness: 'critical' | 'markdown' | 'background'
}

type CspNonceWindow = Window & {
  __FSUSBLOG_CSP_NONCE__?: string
}

const CRITICAL_STYLE_READY_TIMEOUT_MS = 450
const FULL_STYLESHEET_VALIDATION_TIMEOUT_MS = 1500

const PUBLIC_STYLE_FALLBACKS: CriticalStyleLink[] = [
  {
    key: 'public-shell-critical',
    href: import.meta.env.DEV ? '/src/assets/public-shell-critical.css?direct' : null,
    marker: 'public-shell-critical.css',
    readiness: 'critical'
  },
  {
    key: 'tailwind',
    href: import.meta.env.DEV ? '/src/assets/tailwind.css?direct' : null,
    marker: 'tailwind.css',
    readiness: 'critical'
  },
  {
    key: 'markdown',
    href: import.meta.env.DEV ? '/src/assets/markdown.css?direct' : null,
    marker: 'markdown.css',
    readiness: 'markdown'
  },
  {
    key: 'motion',
    href: import.meta.env.DEV ? '/src/assets/motion.css?direct' : null,
    marker: 'motion.css',
    readiness: 'background'
  },
  {
    key: 'public-page',
    href: import.meta.env.DEV ? '/src/assets/public-page.css?direct' : null,
    marker: 'public-page.css',
    readiness: 'critical'
  }
]
const PUBLIC_NAVIGATION_RETRY_DELAYS_MS = [250, 500, 750, 1000]

function isFontOnlyStylesheet(link: HTMLLinkElement): boolean {
  const href = (link.getAttribute('href') ?? '').toLowerCase()
  const marker = (link.dataset.fsusblogStyle ?? '').toLowerCase()
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
    const key = link.dataset.fsusblogStyle?.trim() || link.getAttribute('href') || ''
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    ordered.push(link)
  }
  return ordered
}

function isMarkdownCriticalPath(pathname = window.location.pathname): boolean {
  return /^\/article\/\d+\/?$/i.test(pathname)
    || /^\/about\/?$/i.test(pathname)
    || /^\/privacy\/?$/i.test(pathname)
    || /^\/guidelines\/?$/i.test(pathname)
    || /^\/copyright\/?$/i.test(pathname)
}

function shouldWaitForStyleCandidate(candidate: CriticalStyleLink): boolean {
  return candidate.readiness === 'critical'
    || (candidate.readiness === 'markdown' && isMarkdownCriticalPath())
}

function stylesheetMatchesCandidate(link: HTMLLinkElement, candidate: CriticalStyleLink): boolean {
  const marker = (link.dataset.fsusblogStyle ?? '').trim()
  if (marker === candidate.key) {
    return true
  }

  const href = link.getAttribute('href') ?? ''
  return href.includes(candidate.marker)
}

function listCriticalShellStylesheets(links: HTMLLinkElement[]): HTMLLinkElement[] {
  const criticalCandidates = PUBLIC_STYLE_FALLBACKS.filter(shouldWaitForStyleCandidate)
  return dedupeStylesheetLinks(
    links.filter((link) => criticalCandidates.some((candidate) => stylesheetMatchesCandidate(link, candidate)))
  )
}

function ensureFallbackStylesheets(): HTMLLinkElement[] {
  const head = document.head ?? document.getElementsByTagName('head')[0]
  if (!head) {
    return []
  }

  const presentLinks = listRenderableStylesheets()
  const requiredLinks = PUBLIC_STYLE_FALLBACKS.map((candidate) => {
    const existing = document.querySelector<HTMLLinkElement>(
      `link[rel="stylesheet"][data-fsusblog-style="${candidate.key}"]`
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

    if (!candidate.href) {
      return null
    }

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = candidate.href
    link.dataset.fsusblogStyle = candidate.key
    link.dataset.fsusblogInjected = 'bootstrap'
    head.appendChild(link)
    return link
  }).filter((link): link is HTMLLinkElement => link instanceof HTMLLinkElement)

  return dedupeStylesheetLinks([...presentLinks, ...requiredLinks])
}

function waitForStylesheet(link: HTMLLinkElement, timeoutMs = FULL_STYLESHEET_VALIDATION_TIMEOUT_MS): Promise<boolean> {
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

  const link = document.createElement('link')
  link.id = styleId
  link.rel = 'stylesheet'
  link.href = '/public-shell-emergency.css'
  document.head.appendChild(link)
}

function readCurrentCspNonce(): string {
  const nonceSource = document.querySelector(
    'script[nonce], style[nonce], meta[property="csp-nonce"]'
  ) as (HTMLElement & { nonce?: string }) | null

  return (window as CspNonceWindow).__FSUSBLOG_CSP_NONCE__
    || nonceSource?.nonce
    || nonceSource?.getAttribute('nonce')
    || ''
}

function applyCurrentCspNonceToImportedHead(node: Node): void {
  if (!(node instanceof Element)) {
    return
  }

  const nonce = readCurrentCspNonce()
  if (!nonce) {
    return
  }

  const apply = (element: Element) => {
    const tag = element.tagName.toLowerCase()
    if (tag !== 'style' && tag !== 'script') {
      return
    }

    const target = element as HTMLElement & { nonce?: string }
    target.nonce = nonce
    target.setAttribute('nonce', nonce)
  }

  apply(node)
  node.querySelectorAll('style,script').forEach(apply)
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

  await ensureCriticalPublicShellStylesReady(styleLinks)
  validatePublicShellStylesheetsInBackground(styleLinks)
}

async function ensureCriticalPublicShellStylesReady(styleLinks: HTMLLinkElement[]): Promise<void> {
  const criticalLinks = listCriticalShellStylesheets(styleLinks)
  if (criticalLinks.length === 0) {
    ensureEmergencyPublicShellStyle()
    return
  }

  const loadedStates = await Promise.all(
    criticalLinks.map((link) => waitForStylesheet(link, CRITICAL_STYLE_READY_TIMEOUT_MS))
  )
  const hasRenderableSheet = criticalLinks.some((link) => Boolean(link.sheet))
  if (!hasRenderableSheet || loadedStates.every((loaded) => !loaded)) {
    ensureEmergencyPublicShellStyle()
  }
}

function validatePublicShellStylesheetsInBackground(styleLinks: HTMLLinkElement[]): void {
  void Promise.all(styleLinks.map((link) => waitForStylesheet(link, FULL_STYLESHEET_VALIDATION_TIMEOUT_MS)))
    .then((loadedStates) => {
      const hasRenderableSheet = listRenderableStylesheets().some((link) => Boolean(link.sheet))
      if (!hasRenderableSheet || loadedStates.every((loaded) => !loaded)) {
        ensureEmergencyPublicShellStyle()
      }
    })
    .catch(() => {
      ensureEmergencyPublicShellStyle()
    })
}

let preBootstrapNavigationBound = false
let popstateBound = false
let hydratedPayload: PublicHydrationPayload | null = null
let activeNavigationController: AbortController | null = null
let activeNavigationToken = 0
let hotArticlesIdleTask: number | null = null
let commentsIdleTask: number | null = null
let commentsIntersectionObserver: IntersectionObserver | null = null
let commentsActivationVersion = 0
let publicTakeoverStarted = false
let publicTakeoverCompleted = false
let publicTakeoverPromise: Promise<void> | null = null
let commentsIslandModulePromise: Promise<typeof import('@/public-renderers/commentsIsland')> | null = null

type PublicSeedSnapshotWindow = Window & typeof globalThis & {
  __FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__?: string | null
  __FSUS_PUBLIC_HYDRATION_RAW__?: string | null
}

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  cancelIdleCallback?: (handle: number) => void
}

function scheduleIdleTask(task: () => void): number {
  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    return idleWindow.requestIdleCallback(() => task(), { timeout: 800 })
  }

  return window.setTimeout(task, 180)
}

function clearIdleTask(taskId: number | null): void {
  if (taskId === null) {
    return
  }

  const idleWindow = window as IdleWindow
  if (typeof idleWindow.cancelIdleCallback === 'function') {
    idleWindow.cancelIdleCallback(taskId)
    return
  }

  window.clearTimeout(taskId)
}

function loadCommentsIslandModule(): Promise<typeof import('@/public-renderers/commentsIsland')> {
  commentsIslandModulePromise ??= import('@/public-renderers/commentsIsland')
  return commentsIslandModulePromise
}

async function mountArticleCommentsIslandLazy(
  articleId: number | string,
  reason: 'viewport' | 'request',
  activationVersion = commentsActivationVersion
): Promise<void> {
  const module = await loadCommentsIslandModule()
  if (activationVersion !== commentsActivationVersion) {
    return
  }

  await module.mountArticleCommentsIsland(articleId)
  emitTelemetry('public_comments_island_loaded', { reason }, 'info')
}

function unmountArticleCommentsIslandLazy(): void {
  if (!commentsIslandModulePromise) {
    return
  }

  void commentsIslandModulePromise
    .then((module) => module.unmountArticleCommentsIsland())
    .catch(() => {})
}

function clearArticleCommentsIslandActivation(): void {
  commentsActivationVersion += 1
  commentsIntersectionObserver?.disconnect()
  commentsIntersectionObserver = null
  clearIdleTask(commentsIdleTask)
  commentsIdleTask = null
}

function stopArticleCommentsIslandObserver(): void {
  commentsIntersectionObserver?.disconnect()
  commentsIntersectionObserver = null
  clearIdleTask(commentsIdleTask)
  commentsIdleTask = null
}

function clearPublicFirstPaintFlag(): void {
  document.body.removeAttribute('data-fsusblog-public-first-paint')
}

function waitForDocumentInteractive(): Promise<void> {
  if (document.readyState !== 'loading') {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const complete = (): void => {
      document.removeEventListener('readystatechange', onReadyStateChange)
      document.removeEventListener('DOMContentLoaded', complete)
      resolve()
    }

    const onReadyStateChange = (): void => {
      if (document.readyState !== 'loading') {
        complete()
      }
    }

    document.addEventListener('readystatechange', onReadyStateChange)
    document.addEventListener('DOMContentLoaded', complete, { once: true })
  })
}

async function startPublicTakeover(reason: 'pointerdown' | 'keydown' | 'scroll' | 'search-focus' | 'click'): Promise<void> {
  if (publicTakeoverCompleted) {
    return
  }

  if (publicTakeoverPromise) {
    return await publicTakeoverPromise
  }

  publicTakeoverStarted = true
  clearDynamicIslands()
  publicTakeoverPromise = bootstrapFullApp({
    hydrate: true,
    deferRuntime: true,
    takeover: 'public-shell'
  }).then(() => {
    publicTakeoverCompleted = true
    emitTelemetry('public_shell_takeover_completed', { reason }, 'info')
  }).catch((error) => {
    publicTakeoverStarted = false
    emitTelemetry('public_shell_takeover_failed', {
      reason,
      error: error instanceof Error ? error.message : String(error)
    }, 'warn')
    navigateWithDocumentRequest(window.location.href)
    throw error
  }).finally(() => {
    if (!publicTakeoverCompleted) {
      publicTakeoverPromise = null
    }
  })

  return await publicTakeoverPromise
}

export function schedulePublicTakeover(reason: 'pointerdown' | 'keydown' | 'scroll' | 'search-focus' | 'click'): void {
  if (publicTakeoverStarted || publicTakeoverCompleted) {
    return
  }

  void startPublicTakeover(reason).catch(() => {})
}

function isPublicMicroRoute(href: string): boolean {
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

function clearDynamicIslands(): void {
  clearIdleTask(hotArticlesIdleTask)
  hotArticlesIdleTask = null
  clearArticleCommentsIslandActivation()
  unmountArticleCommentsIslandLazy()
  unmountHomeHotArticlesIsland()
}

function resolveArticleCommentsIslandId(payload: PublicHydrationPayload): number | null {
  if (payload.pageKind !== 'ArticleDetail') {
    return null
  }

  const articleId = Number(payload.articleId)
  return Number.isFinite(articleId) && articleId > 0 ? Math.trunc(articleId) : null
}

function scheduleArticleCommentsIsland(payload: PublicHydrationPayload): void {
  const articleId = resolveArticleCommentsIslandId(payload)
  if (articleId === null) {
    return
  }

  const host = document.getElementById('fsus-comments-island')
  if (!(host instanceof HTMLElement)) {
    return
  }

  const activationVersion = ++commentsActivationVersion
  const activate = (reason: 'viewport' | 'request') => {
    stopArticleCommentsIslandObserver()
    void mountArticleCommentsIslandLazy(articleId, reason, activationVersion)
  }

  if (window.location.hash === '#comments') {
    activate('request')
    return
  }

  if (typeof IntersectionObserver === 'undefined') {
    return
  }

  commentsIntersectionObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
      activate('viewport')
    }
  }, {
    root: null,
    rootMargin: '900px 0px 900px 0px',
    threshold: 0
  })
  commentsIntersectionObserver.observe(host)
}

function scheduleDynamicIslands(payload: PublicHydrationPayload | null): void {
  clearIdleTask(hotArticlesIdleTask)
  hotArticlesIdleTask = null
  clearArticleCommentsIslandActivation()

  if (!payload) {
    return
  }

  if (payload.pageKind === 'Home') {
    hotArticlesIdleTask = scheduleIdleTask(() => {
      hotArticlesIdleTask = null
      void mountHomeHotArticlesIsland(payload.routeKey)
    })
  }

  if (payload.pageKind === 'ArticleDetail') {
    scheduleArticleCommentsIsland(payload)
  }
}

function getCurrentShell(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#app > #fsus-aot-shell')
}

function replaceBinaryScript(id: string, rawPayload: string | null): void {
  const existing = document.getElementById(id)
  if (!rawPayload) {
    existing?.remove()
    if (id === 'fsus-aot-bootstrap') {
      (window as PublicSeedSnapshotWindow).__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__ = null
    }
    if (id === 'fsus-aot-hydration-props') {
      (window as PublicSeedSnapshotWindow).__FSUS_PUBLIC_HYDRATION_RAW__ = null
    }
    return
  }

  const target = existing ?? (() => {
    const created = document.createElement('script')
    created.id = id
    created.type = AEDS_BINARY_MEDIA_TYPE
    document.body.appendChild(created)
    return created
  })()

  target.textContent = rawPayload
  if (id === 'fsus-aot-bootstrap') {
    (window as PublicSeedSnapshotWindow).__FSUS_PUBLIC_AOT_BOOTSTRAP_RAW__ = rawPayload
  }
  if (id === 'fsus-aot-hydration-props') {
    (window as PublicSeedSnapshotWindow).__FSUS_PUBLIC_HYDRATION_RAW__ = rawPayload
  }
}

function syncShellAttributes(target: HTMLElement, source: HTMLElement): void {
  for (const { name } of Array.from(target.attributes)) {
    if (name === 'id' || name === 'data-public-shell-probe') {
      continue
    }

    if (!source.hasAttribute(name)) {
      target.removeAttribute(name)
    }
  }

  for (const { name, value } of Array.from(source.attributes)) {
    if (name === 'id') {
      continue
    }
    target.setAttribute(name, value)
  }

  target.removeAttribute('data-public-hydrated')
}

function canPatchNode(current: Node, next: Node): boolean {
  if (current.nodeType !== next.nodeType) {
    return false
  }

  if (current instanceof Element && next instanceof Element) {
    return current.tagName === next.tagName
      && current.id === next.id
      && current.getAttribute('data-public-nav') === next.getAttribute('data-public-nav')
      && current.getAttribute('data-public-hydration-kind') === next.getAttribute('data-public-hydration-kind')
  }

  return current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE
}

function syncElementAttributes(target: Element, source: Element): void {
  for (const { name } of Array.from(target.attributes)) {
    if (!source.hasAttribute(name)) {
      target.removeAttribute(name)
    }
  }

  for (const { name, value } of Array.from(source.attributes)) {
    if (target.getAttribute(name) !== value) {
      target.setAttribute(name, value)
    }
  }
}

function patchNode(current: Node, next: Node): void {
  if (!canPatchNode(current, next)) {
    current.parentNode?.replaceChild(document.importNode(next, true), current)
    return
  }

  if (current instanceof Text && next instanceof Text) {
    if (current.data !== next.data) {
      current.data = next.data
    }
    return
  }

  if (!(current instanceof Element) || !(next instanceof Element)) {
    return
  }

  syncElementAttributes(current, next)
  syncChildNodes(current, next)
}

function syncChildNodes(target: Element, source: Element): void {
  const nextChildren = Array.from(source.childNodes)
  for (let index = 0; index < nextChildren.length; index++) {
    const next = nextChildren[index]
    const current = target.childNodes[index]
    if (!current) {
      target.appendChild(document.importNode(next, true))
      continue
    }

    patchNode(current, next)
  }

  while (target.childNodes.length > nextChildren.length) {
    target.lastChild?.remove()
  }
}

function syncHeadFromDocument(targetDocument: Document): void {
  if (targetDocument.title) {
    document.title = targetDocument.title
  }

  document.head.querySelectorAll('[data-fsus-aot-head]').forEach((node) => node.remove())
  targetDocument.head.querySelectorAll('[data-fsus-aot-head]').forEach((node) => {
    const imported = document.importNode(node, true)
    applyCurrentCspNonceToImportedHead(imported)
    document.head.appendChild(imported)
  })
}

function stripInlineStyleTagsForDetachedParse(html: string): string {
  return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

function updateHistoryStateForCurrentScroll(): void {
  const state = history.state && typeof history.state === 'object' ? history.state as Record<string, unknown> : {}
  history.replaceState({
    ...state,
    __fsusPublicShell: true,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  }, '', window.location.href)
}

function getRestoreScrollPosition(state: unknown): { left: number; top: number } {
  if (!state || typeof state !== 'object') {
    return { left: 0, top: 0 }
  }

  const record = state as Record<string, unknown>
  const left = Number(record.scrollX)
  const top = Number(record.scrollY)
  return {
    left: Number.isFinite(left) ? Math.max(0, Math.trunc(left)) : 0,
    top: Number.isFinite(top) ? Math.max(0, Math.trunc(top)) : 0
  }
}

function readBinaryTextById(doc: Document, id: string): string | null {
  const text = doc.getElementById(id)?.textContent?.trim()
  return text ? text : null
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function isHydratablePublicDocument(doc: Document): boolean {
  return Boolean(
    doc.querySelector('#app > #fsus-aot-shell')
    && readBinaryTextById(doc, 'fsus-aot-hydration-props')
  )
}

async function applyPublicNavigationDocument(
  targetDocument: Document,
  href: string,
  historyMode: 'push' | 'replace' | 'none',
  popState?: unknown
): Promise<void> {
  const targetShell = targetDocument.querySelector<HTMLElement>('#app > #fsus-aot-shell')
  const currentShell = getCurrentShell()
  const hydrationPayload = readBinaryTextById(targetDocument, 'fsus-aot-hydration-props')
  if (!targetShell || !currentShell || !hydrationPayload) {
    throw new Error('invalid public shell document')
  }

  const payload = replacePublicHydrationPayloadBinary(hydrationPayload)
  if (!payload) {
    throw new Error('invalid public hydration payload')
  }

  clearDynamicIslands()
  syncHeadFromDocument(targetDocument)
  syncShellAttributes(currentShell, targetShell)
  syncChildNodes(currentShell, targetShell)

  replaceBinaryScript('fsus-aot-bootstrap', readBinaryTextById(targetDocument, 'fsus-aot-bootstrap'))
  replaceBinaryScript('fsus-aot-islands', readBinaryTextById(targetDocument, 'fsus-aot-islands'))

  hydratedPayload = payload
  await hydratePublicPage(payload)
  scheduleDynamicIslands(payload)
  clearPublicFirstPaintFlag()

  if (historyMode === 'push') {
    history.pushState({ __fsusPublicShell: true, scrollX: 0, scrollY: 0 }, '', href)
    scrollToHashOrTop(href)
  } else if (historyMode === 'replace') {
    history.replaceState({ __fsusPublicShell: true, ...getRestoreScrollPosition(popState) }, '', href)
    const { left, top } = getRestoreScrollPosition(popState)
    if (new URL(href, window.location.origin).hash) {
      scrollToHashOrTop(href)
    } else {
      window.scrollTo({ left, top, behavior: 'auto' })
    }
  }
}

async function navigateWithinPublicShell(
  href: string,
  options: {
    historyMode?: 'push' | 'replace' | 'none'
    popState?: unknown
  } = {}
): Promise<void> {
  const target = new URL(href, window.location.origin)
  const current = new URL(window.location.href)
  if (target.pathname === current.pathname && target.search === current.search && target.hash === current.hash) {
    return
  }

  if (!isPublicMicroRoute(target.toString())) {
    navigateWithDocumentRequest(target.toString())
    return
  }

  if ((options.historyMode ?? 'push') === 'push') {
    updateHistoryStateForCurrentScroll()
  }
  activeNavigationController?.abort()
  const controller = new AbortController()
  activeNavigationController = controller
  const navigationToken = ++activeNavigationToken

  try {
    for (let attempt = 0; attempt <= PUBLIC_NAVIGATION_RETRY_DELAYS_MS.length; attempt += 1) {
      const response = await fetch(target.toString(), {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'X-Fsus-Public-Navigation': '1'
        },
        credentials: 'same-origin',
        signal: controller.signal
      })

      if (!response.ok) {
        throw new Error(`public navigation failed: ${response.status}`)
      }

      const html = await response.text()
      if (controller.signal.aborted || navigationToken !== activeNavigationToken) {
        return
      }

      const nextDocument = new DOMParser().parseFromString(stripInlineStyleTagsForDetachedParse(html), 'text/html')
      if (isHydratablePublicDocument(nextDocument)) {
        await applyPublicNavigationDocument(
          nextDocument,
          target.toString(),
          options.historyMode ?? 'push',
          options.popState
        )
        return
      }

      const retryDelay = PUBLIC_NAVIGATION_RETRY_DELAYS_MS[attempt]
      if (retryDelay == null) {
        break
      }
      await delay(retryDelay, controller.signal)
      if (controller.signal.aborted || navigationToken !== activeNavigationToken) {
        return
      }
    }

    throw new Error('public navigation shell was not ready')
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      return
    }

    navigateWithDocumentRequest(target.toString())
  } finally {
    if (activeNavigationController === controller) {
      activeNavigationController = null
    }
  }
}

async function handleShellAction(actionNode: HTMLElement, anchor: HTMLAnchorElement | null): Promise<void> {
  const action = actionNode.dataset.aotAction ?? ''
  if (!action) {
    return
  }

  const actionHref = resolveShellActionNavigation(actionNode)
  if (actionHref) {
    dispatchAotAction(actionNode)
    await navigateWithinPublicShell(actionHref)
    return
  }

  if (action === 'activate-comments') {
    dispatchAotAction(actionNode)
    const articleId = hydratedPayload?.pageKind === 'ArticleDetail'
      ? hydratedPayload.articleId
      : Number(actionNode.dataset.aotValue ?? actionNode.dataset.aotId ?? '0')
    const activationVersion = ++commentsActivationVersion
    stopArticleCommentsIslandObserver()
    await mountArticleCommentsIslandLazy(articleId, 'request', activationVersion)
    return
  }

  dispatchAotAction(actionNode)
  if (anchor instanceof HTMLAnchorElement && isInternalAppLink(anchor) && isPublicMicroRoute(anchor.href)) {
    await navigateWithinPublicShell(anchor.href)
  }
}

export function bindPreBootstrapNavigation(): void {
  if (preBootstrapNavigationBound) {
    return
  }

  preBootstrapNavigationBound = true
  document.addEventListener('click', (event) => {
    if (publicTakeoverStarted || publicTakeoverCompleted) {
      return
    }

    if (!(event.target instanceof Element) || isModifiedEvent(event)) {
      return
    }

    const themeModeNode = event.target.closest('[data-fsusblog-theme-mode]')
    if (themeModeNode instanceof HTMLElement) {
      const nextMode = themeModeNode.dataset.fsusblogThemeMode
      if (nextMode === 'light' || nextMode === 'dark' || nextMode === 'system') {
        event.preventDefault()
        setThemeMode(nextMode as ThemeMode)
      }
      return
    }

    const actionNode = event.target.closest('[data-aot-action]')
    if (actionNode instanceof HTMLElement && !actionNode.hasAttribute('disabled')) {
      const anchor = actionNode.closest('a')

      const actionHref = resolveShellActionNavigation(actionNode)
      if (actionHref) {
        event.preventDefault()
        void navigateWithinPublicShell(actionHref)
        return
      }

      event.preventDefault()
      void handleShellAction(actionNode, anchor instanceof HTMLAnchorElement ? anchor : null)
      return
    }

    const anchor = event.target.closest('a')
    if (!(anchor instanceof HTMLAnchorElement) || !isInternalAppLink(anchor)) {
      return
    }

    if (!isPublicMicroRoute(anchor.href)) {
      return
    }

    event.preventDefault()
    void navigateWithinPublicShell(anchor.href)
  }, { passive: false })
}

export function bindPopStateNavigation(): void {
  if (popstateBound) {
    return
  }

  popstateBound = true
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual'
  }

  window.addEventListener('popstate', (event) => {
    if (publicTakeoverStarted || publicTakeoverCompleted) {
      return
    }

    if (!isPublicSeoPath(window.location.pathname)) {
      return
    }

    void navigateWithinPublicShell(window.location.href, {
      historyMode: 'replace',
      popState: event.state
    })
  })
}

async function hydratePublicShell(): Promise<void> {
  const payload = readPublicHydrationPayload()
  if (!payload) {
    return
  }

  hydratedPayload = payload
  const startedAt = performance.now()
  await hydratePublicPage(payload)
  scheduleDynamicIslands(payload)
  const durationMs = Math.round(performance.now() - startedAt)
  emitRumMetric('hydration_time', {
    value: durationMs,
    durationMs
  })
  clearPublicFirstPaintFlag()
}

export async function bootstrapPublicShell(): Promise<void> {
  ensureThemeRuntime()
  document.body.setAttribute('data-fsusblog-public-first-paint', 'true')
  bindPreBootstrapNavigation()
  bindPopStateNavigation()
  const hydrateTask = (async () => {
    await waitForDocumentInteractive()
    await hydratePublicShell()
  })()

  await ensurePublicShellStylesReady()
  removeGlobalLoader()

  try {
    await hydrateTask
  } catch (error) {
    emitTelemetry('public_shell_hydration_failed', {
      error: error instanceof Error ? error.message : String(error)
    }, 'warn')
  }
}
