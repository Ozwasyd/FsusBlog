import { readPublicHydrationPayload, replacePublicHydrationPayloadJson } from '@/bootstrap/publicHydrationBootstrap'
import { hydratePublicPage, type PublicHydrationPayload } from '@/public-renderers'
import {
  isPublicSeoPath,
  removeGlobalLoader
} from '@/bootstrap/publicShellPrimitives'
import { emitTelemetry } from '@/services/telemetryService'
import { ensureThemeRuntime, setThemeMode, type ThemeMode } from '@/services/themeRuntime'
import { mountArticleCommentsIsland, unmountArticleCommentsIsland } from '@/public-renderers/commentsIsland'
import { mountHomeHotArticlesIsland, unmountHomeHotArticlesIsland } from '@/public-renderers/homeHotArticlesIsland'

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
  href: string | null
  marker: string
}

const CRITICAL_STYLE_FALLBACKS: CriticalStyleLink[] = [
  {
    key: 'public-shell-critical',
    href: import.meta.env.DEV ? '/src/assets/public-shell-critical.css?direct' : null,
    marker: 'public-shell-critical.css'
  },
  {
    key: 'public-page',
    href: import.meta.env.DEV ? '/src/assets/public-page.css?direct' : null,
    marker: 'public-page.css'
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

    if (!candidate.href) {
      return null
    }

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = candidate.href
    link.dataset.fsusStyle = candidate.key
    link.dataset.fsusInjected = 'bootstrap'
    head.appendChild(link)
    return link
  }).filter((link): link is HTMLLinkElement => link instanceof HTMLLinkElement)

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
#fsus-aot-shell{font-family:var(--font-sans,"Google Sans","Noto Sans SC","Noto Sans TC","Noto Sans JP",ui-sans-serif,system-ui,sans-serif);background:var(--fsus-page-bg,#fff);color:var(--fsus-text-primary,#09090b);line-height:1.6}
#fsus-aot-shell a{color:var(--fsus-text-secondary,#27272a);text-decoration:none}
#fsus-aot-shell .mono-link,#fsus-aot-shell .active-link{font-size:.875rem}
#fsus-aot-shell .active-link{color:var(--fsus-text-primary,#09090b);font-weight:700}
#fsus-aot-shell .ui-article-card{display:flex;flex-direction:column;gap:.75rem}
#fsus-aot-shell .ui-article-title{font-size:1.35rem;line-height:1.3;font-weight:700;color:var(--fsus-text-primary,#09090b)}
#fsus-aot-shell .ui-article-summary{font-size:.96rem;line-height:1.75;color:var(--fsus-text-secondary,#52525b)}
#fsus-aot-shell .ui-pagination{display:flex;align-items:center;justify-content:space-between;margin-top:2rem;padding-top:1rem;border-top:1px solid var(--fsus-panel-border,#f4f4f5)}
#fsus-aot-shell [data-aot-action="page-prev"],#fsus-aot-shell [data-aot-action="page-next"]{background:transparent;border:0;color:var(--fsus-text-secondary,#52525b);font-size:.75rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
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

let preBootstrapNavigationBound = false
let popstateBound = false
let hydratedPayload: PublicHydrationPayload | null = null
let activeNavigationController: AbortController | null = null
let activeNavigationToken = 0
let hotArticlesIdleTask: number | null = null
let commentsIdleTask: number | null = null

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

function clearPublicFirstPaintFlag(): void {
  document.body.removeAttribute('data-fsus-public-first-paint')
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
  clearIdleTask(commentsIdleTask)
  commentsIdleTask = null
  unmountArticleCommentsIsland()
  unmountHomeHotArticlesIsland()
}

function scheduleDynamicIslands(payload: PublicHydrationPayload | null): void {
  clearIdleTask(hotArticlesIdleTask)
  hotArticlesIdleTask = null
  clearIdleTask(commentsIdleTask)
  commentsIdleTask = null

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
    commentsIdleTask = scheduleIdleTask(() => {
      commentsIdleTask = null
      void mountArticleCommentsIsland(payload.articleId)
    })
  }
}

function getCurrentShell(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#app > #fsus-aot-shell')
}

function replaceJsonScript(id: string, rawJson: string | null): void {
  const existing = document.getElementById(id)
  if (!rawJson) {
    existing?.remove()
    return
  }

  const target = existing ?? (() => {
    const created = document.createElement('script')
    created.id = id
    created.type = 'application/json'
    document.body.appendChild(created)
    return created
  })()

  target.textContent = rawJson
}

function syncShellAttributes(target: HTMLElement, source: HTMLElement): void {
  for (const { name } of Array.from(target.attributes)) {
    if (name === 'id') {
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

function importChildNodes(source: HTMLElement): Node[] {
  return Array.from(source.childNodes).map((node) => document.importNode(node, true))
}

function syncMetaTagFromDocument(targetDocument: Document, selector: string): void {
  const current = document.head.querySelector(selector)
  const next = targetDocument.head.querySelector(selector)

  if (!(next instanceof HTMLElement)) {
    current?.remove()
    return
  }

  const clone = document.importNode(next, true)
  if (current) {
    current.replaceWith(clone)
    return
  }

  document.head.appendChild(clone)
}

function syncHeadFromDocument(targetDocument: Document): void {
  if (targetDocument.title) {
    document.title = targetDocument.title
  }

  syncMetaTagFromDocument(targetDocument, 'link[rel="canonical"]')
  syncMetaTagFromDocument(targetDocument, 'meta[name="description"]')
  syncMetaTagFromDocument(targetDocument, 'meta[property="og:title"]')
  syncMetaTagFromDocument(targetDocument, 'meta[property="og:description"]')
  syncMetaTagFromDocument(targetDocument, 'meta[property="og:type"]')
  syncMetaTagFromDocument(targetDocument, 'meta[property="og:url"]')
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

function readJsonTextById(doc: Document, id: string): string | null {
  const text = doc.getElementById(id)?.textContent?.trim()
  return text ? text : null
}

async function applyPublicNavigationDocument(
  targetDocument: Document,
  href: string,
  historyMode: 'push' | 'replace' | 'none',
  popState?: unknown
): Promise<void> {
  const targetShell = targetDocument.querySelector<HTMLElement>('#app > #fsus-aot-shell')
  const currentShell = getCurrentShell()
  const hydrationJson = readJsonTextById(targetDocument, 'fsus-aot-hydration-props')
  if (!targetShell || !currentShell || !hydrationJson) {
    throw new Error('invalid public shell document')
  }

  const payload = replacePublicHydrationPayloadJson(hydrationJson)
  if (!payload) {
    throw new Error('invalid public hydration payload')
  }

  clearDynamicIslands()
  syncHeadFromDocument(targetDocument)
  syncShellAttributes(currentShell, targetShell)
  currentShell.replaceChildren(...importChildNodes(targetShell))

  replaceJsonScript('fsus-aot-bootstrap', readJsonTextById(targetDocument, 'fsus-aot-bootstrap'))
  replaceJsonScript('fsus-aot-islands', readJsonTextById(targetDocument, 'fsus-aot-islands'))

  hydratedPayload = payload
  await hydratePublicPage(payload)
  scheduleDynamicIslands(payload)
  clearPublicFirstPaintFlag()

  if (historyMode === 'push') {
    history.pushState({ __fsusPublicShell: true, scrollX: 0, scrollY: 0 }, '', href)
    window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
  } else if (historyMode === 'replace') {
    history.replaceState({ __fsusPublicShell: true, ...getRestoreScrollPosition(popState) }, '', href)
    const { left, top } = getRestoreScrollPosition(popState)
    window.scrollTo({ left, top, behavior: 'auto' })
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

    const nextDocument = new DOMParser().parseFromString(html, 'text/html')
    await applyPublicNavigationDocument(
      nextDocument,
      target.toString(),
      options.historyMode ?? 'push',
      options.popState
    )
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
    await mountArticleCommentsIsland(articleId)
    return
  }

  dispatchAotAction(actionNode)
  if (anchor instanceof HTMLAnchorElement && isInternalAppLink(anchor) && isPublicMicroRoute(anchor.href)) {
    await navigateWithinPublicShell(anchor.href)
  }
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

    const themeModeNode = event.target.closest('[data-fsus-theme-mode]')
    if (themeModeNode instanceof HTMLElement) {
      const nextMode = themeModeNode.dataset.fsusThemeMode
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

function bindPopStateNavigation(): void {
  if (popstateBound) {
    return
  }

  popstateBound = true
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual'
  }

  window.addEventListener('popstate', (event) => {
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
  await hydratePublicPage(payload)
  scheduleDynamicIslands(payload)
  clearPublicFirstPaintFlag()
}

export async function bootstrapPublicShell(): Promise<void> {
  ensureThemeRuntime()
  document.body.setAttribute('data-fsus-public-first-paint', 'true')
  const hydrateTask = hydratePublicShell()

  await ensurePublicShellStylesReady()
  removeGlobalLoader()

  try {
    await hydrateTask
  } catch (error) {
    emitTelemetry('public_shell_hydration_failed', {
      error: error instanceof Error ? error.message : String(error)
    }, 'warn')
  } finally {
    bindPreBootstrapNavigation()
    bindPopStateNavigation()
  }
}
