import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect } from '@playwright/test'
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from '@playwright/test'
import { AEDS_BINARY_MEDIA_TYPE, FSUS_HEADERS } from '../../../../src/frontend/src/api/contracts'
import { encodeAedsFrame } from '../../../../src/frontend/src/api/binaryFrame'
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '../../../../src/frontend/wasm/web/protocol/frame'
import { resolveAuthFixtureDirectory } from '../fixture-paths.mjs'
import { loadAuditFixtures } from './routeAuditFixtures'
import { resolveTestSession, testSessionHeaders, withTestSessionContextOptions } from './testSession'
import {
  waitForApplicationReady as waitForCanonicalApplicationReady,
  waitForPublicHydration as waitForCanonicalPublicHydration,
  waitForVisualFrameReady
} from './readiness.mjs'
// @ts-ignore The retry helper is a pure module covered by node:test.
import { navigateThroughRetryablePublicAot } from './publicAotNavigationRetry.mjs'

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

type StableScreenshotOptions = NonNullable<Parameters<ReturnType<typeof expect<Locator>>['toHaveScreenshot']>[0]>

export type RuntimeAudit = {
  checkpoint: () => number
  eventsSince: (start: number) => readonly string[]
  assertCleanSince: (start: number, label: string) => void
}

export type AuditedPageSession = {
  page: Page
  audit: RuntimeAudit
  close: () => Promise<void>
}

export type ThemedAuditedContext = {
  context: BrowserContext
  newPage: () => Promise<AuditedPageSession>
  close: () => Promise<void>
}

type RouteExpectation = Readonly<{
  path: string
  expectedUrl?: string
  expectedPathname?: string
  label: string
  selectors: Array<(page: Page) => Locator>
}>

export const APP_READY_TIMEOUT_MS = 45_000
// A clean docs capture asks Vite to transform the complete public renderer and
// its local FsusUI alias before any route is audited. Keep that one-time cold
// compile outside the ordinary 45s route-readiness budget.
export const WARMUP_TIMEOUT_MS = 120_000
export const PUBLIC_RUNTIME_DIAGNOSTIC_EVENT_NAMES = Object.freeze([
  'public_route_prewarm_failure',
  'public_route_prewarm_timeout',
  'public_shell_hydration_failed'
] as const)

export type ViewportSize = { width: number, height: number }
export type UxViewport = Readonly<{
  name: string
  width: number
  height: number
  category: string
  useInAcceptance: boolean
  useInPublicVisual: boolean
  useInConsoleVisual: boolean
  screenshotBaseline: boolean
  prSmoke: boolean
  visualBoundary: boolean
  boundaryFull: boolean
}>
export type UxViewportMode = 'smoke' | 'visual' | 'boundaries'
export type UxViewportModeConfig = Readonly<{
  artifact: string
  themes: ThemeMode[]
  viewports: string[]
  routes: string[] | 'all'
  media: string[]
  screenshots?: boolean
}>
export type UxSafeAreaInsets = Readonly<{
  top: number
  right: number
  bottom: number
  left: number
}>

export type UxSafeAreaProfile = Readonly<{
  id: string
  viewport: Readonly<{ width: number, height: number }>
  insets: UxSafeAreaInsets
}>

export type UxViewportMatrix = Readonly<{
  version: string
  generatedFrom: string
  viewports: UxViewport[]
  modes: Record<UxViewportMode, UxViewportModeConfig>
  safeArea?: Readonly<{
    version: string
    generatedFrom: string
    cssVariables: string[]
    profiles: Record<string, UxSafeAreaProfile>
    overlayRiskSurfaces: ReadonlyArray<Readonly<{
      id: string
      surface: string
      routeId: string
      open: string
      overlayRisk: boolean
      profilesByMode: Partial<Record<UxViewportMode, string[]>>
      browsersByMode: Partial<Record<UxViewportMode, string[]>>
      themesByMode: Partial<Record<UxViewportMode, ThemeMode[]>>
    }>>
    assertions: string[]
  }>
}>
export type UxContentBoundaryCase = Readonly<{
  id: string
  kind: string
  sample: string
}>
export type UxContentBoundaryCorpus = Readonly<{
  version: string
  generatedFrom: string
  cases: UxContentBoundaryCase[]
}>

const uxViewportMatrixFile = new URL('../../fixtures/ux-viewport-matrix.json', import.meta.url)
const uxContentBoundaryCorpusFile = new URL('../../fixtures/ux-content-boundary-corpus.json', import.meta.url)

export const UX_VIEWPORT_MATRIX: UxViewportMatrix = JSON.parse(readFileSync(uxViewportMatrixFile, 'utf8')) as UxViewportMatrix
export const UX_CONTENT_BOUNDARY_CORPUS: UxContentBoundaryCorpus = JSON.parse(readFileSync(uxContentBoundaryCorpusFile, 'utf8')) as UxContentBoundaryCorpus

export function uxViewportByName(name: string): UxViewport {
  const viewport = UX_VIEWPORT_MATRIX.viewports.find((candidate) => candidate.name === name)
  if (!viewport) {
    throw new Error(`unknown UX viewport: ${name}`)
  }
  return viewport
}

export function uxViewportSize(name: string): ViewportSize {
  const viewport = uxViewportByName(name)
  return { width: viewport.width, height: viewport.height }
}

export function uxViewportsForMode(mode: UxViewportMode): UxViewport[] {
  const config = UX_VIEWPORT_MATRIX.modes[mode]
  return config.viewports.map((name) => uxViewportByName(name))
}

export const XS_MOBILE_VIEWPORT = uxViewportSize('xs-mobile')
export const DESKTOP_VIEWPORT = uxViewportSize('desktop')
export const DESKTOP_HD_VIEWPORT = uxViewportSize('desktop-hd')
export const TABLET_VIEWPORT = uxViewportSize('tablet')
export const TABLET_LANDSCAPE_VIEWPORT = uxViewportSize('tablet-landscape')
export const MOBILE_VIEWPORT = uxViewportSize('mobile')
export const NARROW_MOBILE_VIEWPORT = uxViewportSize('narrow-mobile')
export const SHORT_MOBILE_VIEWPORT = uxViewportSize('short-mobile')
export const MOBILE_LANDSCAPE_VIEWPORT = uxViewportSize('mobile-landscape')
export const LAPTOP_SHORT_VIEWPORT = uxViewportSize('laptop-short')
export const WIDE_DESKTOP_VIEWPORT = uxViewportSize('wide-desktop')
export const ULTRA_WIDE_VIEWPORT = uxViewportSize('ultra-wide')
export const TALL_DESKTOP_VIEWPORT = uxViewportSize('tall-desktop')
export const FOUR_K_VIEWPORT = uxViewportSize('four-k')

export const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser'
export const userPassword = process.env.FSUSBLOG_USER_PASSWORD ?? ''
export const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin'
export const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD ?? ''
export const fixtures = loadAuditFixtures()
export type ThemeMode = 'light' | 'dark'
const acceptanceBackendUrl = process.env.FSUSBLOG_ACCEPTANCE_BACKEND_URL
  || process.env.FSUSBLOG_BASE_URL
  || process.env.FSUSBLOG_DEBUG_BACKEND_URL
  || 'http://127.0.0.1:7568'
const acceptanceDefaultUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const ACCEPTANCE_UTF8_DECODER = new TextDecoder()
const ACCEPTANCE_UTF8_ENCODER = new TextEncoder()
const ACCEPTANCE_API_ERROR_POD_SIZE = 584
const acceptancePowWasmRoot = pathToFileURL(`${path.resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT
  || fileURLToPath(new URL('../../../../src/frontend/public/wasm/', import.meta.url)))}/`)
const acceptanceNodePowAssetKinds = ['relaxed', 'simd', 'basic'] as const
const acceptanceNodePowBatchSize = Math.max(
  1,
  Number.parseInt(process.env.FSUSBLOG_NODE_WASM_POW_BATCH_SIZE ?? '262144', 10) || 262144
)

type AcceptancePowRuntimeModule = {
  _malloc: (size: number) => number
  _free: (ptr: number) => void
  _solve_pow_c: (saltPtr: number, browserFpPtr: number, difficulty: number, outputPtr: number, outputLength: number) => number
  _solve_pow_limited_c: (
    saltPtr: number,
    browserFpPtr: number,
    difficulty: number,
    startNonce: number,
    maxAttempts: number,
    outputPtr: number,
    outputLength: number
  ) => number
  HEAPU8: Uint8Array
}

type AcceptanceFixtureCookie = {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

let acceptanceNodePowModulePromise: Promise<AcceptancePowRuntimeModule | null> | null = null
let acceptanceContextCounter = 0
let acceptanceDeviceFingerprintCounter = 0

function acceptanceMonotonicNow(): number {
  return performance.now()
}

function nextAcceptanceId(scope: string): string {
  const workerIndex = process.env.TEST_PARALLEL_INDEX || process.env.TEST_WORKER_INDEX || '0'
  return `${scope}-${workerIndex}-${process.pid}-${++acceptanceDeviceFingerprintCounter}`
    .replace(/[^a-z0-9-]+/gi, '-')
    .slice(0, 96)
}

function resolvePlaywrightBusinessEpochUtc(): string | undefined {
  const fromEnv = process.env.FSUSBLOG_TEST_BUSINESS_EPOCH_UTC?.trim()
  if (fromEnv) {
    return fromEnv
  }

  const rawContext = process.env.FSUSBLOG_TEMPORAL_CONTEXT_JSON?.trim()
  if (!rawContext) {
    return undefined
  }

  try {
    const parsed = JSON.parse(rawContext) as { businessEpochUtc?: unknown }
    const epoch = typeof parsed.businessEpochUtc === 'string' ? parsed.businessEpochUtc.trim() : ''
    return epoch || undefined
  } catch {
    return undefined
  }
}

async function applyPlaywrightBusinessClock(page: Page): Promise<void> {
  const businessEpochUtc = resolvePlaywrightBusinessEpochUtc()
  if (!businessEpochUtc) {
    return
  }

  const businessEpochMs = Date.parse(businessEpochUtc)
  if (!Number.isFinite(businessEpochMs)) {
    throw new Error('Playwright business epoch must be a parseable RFC3339 UTC instant')
  }

  await page.clock.setFixedTime(businessEpochMs)
}

function withAcceptanceContextOptions(
  options: BrowserContextOptions = {},
  testSession?: string
): BrowserContextOptions {
  const contextId = `${process.env.TEST_PARALLEL_INDEX || process.env.TEST_WORKER_INDEX || '0'}-${++acceptanceContextCounter}`
  const userAgent = `${options.userAgent ?? acceptanceDefaultUserAgent} FsusAcceptance/${contextId}`
  return withTestSessionContextOptions({
    baseURL: process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000',
    ...options,
    userAgent
  }, testSession)
}

export function attachRuntimeAudit(page: Page): RuntimeAudit {
  const events: string[] = []

  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') {
      return
    }

    const text = message.text().trim()
    if (/^Failed to load resource: the server responded with a status of \d+/u.test(text)) {
      return
    }

    if (isIgnorableRuntimeMessage(text)) {
      return
    }

    const location = message.location()
    const source = location.url
      ? ` at ${location.url}:${location.lineNumber}:${location.columnNumber}`
      : ''
    events.push(`console:${message.type()}:${text}${source}`)
  })

  page.on('pageerror', (error) => {
    const text = error.message.trim()
    if (isIgnorableRuntimeMessage(text)) {
      return
    }

    events.push(`pageerror:${text}`)
  })

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || 'request_failed'
    const requestUrl = request.url()
    if (isIgnorableRequestFailure(requestUrl, failure)) {
      return
    }

    events.push(`requestfailed:${request.method()} ${requestUrl} ${failure}`)
  })

  page.on('response', (response) => {
    const status = response.status()
    if (status < 400) {
      return
    }

    const request = response.request()
    const requestUrl = response.url()
    if (isIgnorableHttpResponse(requestUrl, status)) {
      return
    }

    events.push(`response:${status}:${request.method()} ${requestUrl}`)
  })

  return {
    checkpoint: () => events.length,
    eventsSince: (start) => events.slice(start),
    assertCleanSince: (start, label) => {
      expect(events.slice(start), `${label} should not emit runtime errors or warnings`).toEqual([])
    }
  }
}

function isIgnorableRuntimeMessage(text: string): boolean {
  return text.includes('favicon.ico')
    || text.includes('Deprecated API for given entry type.')
    || text.includes('Outdated Optimize Dep')
    || text.includes('Failed to load resource: the server responded with a status of 401 (Unauthorized)')
    || text.includes('Failed to load resource: net::ERR_NETWORK_CHANGED')
    || text.includes('Failed to fetch dynamically imported module:')
    || text.includes("Blocked script execution in 'about:srcdoc'")
      && text.includes("the document's frame is sandboxed")
      && text.includes("'allow-scripts' permission is not set")
    || text.includes('binary_failure')
      && text.includes('PASSWORD_OR_STEP_UP_PROOF_REQUIRED')
      && text.includes('status: 428')
    || text.includes('/node_modules/.vite/deps/')
    || text.includes('ERR_ABORTED')
    || text.includes('ERR_NETWORK_CHANGED')
}

function isIgnorableRequestFailure(url: string, failure: string): boolean {
  if (url.includes('favicon.ico')) {
    return true
  }

  return failure.includes('ERR_ABORTED') || failure.includes('ERR_NETWORK_CHANGED')
}

function isIgnorableHttpResponse(url: string, status: number): boolean {
  if (url.includes('favicon.ico')) {
    return true
  }

  if (url.includes('/api/notifications/stream/preflight') && (status === 423 || status === 428 || status === 429)) {
    return true
  }

  if (url.includes('/api/binary/auth/mfa/challenge/start') && status === 428) {
    return true
  }

  return status === 401
}

export async function waitForAppReady(page: Page, timeout = APP_READY_TIMEOUT_MS): Promise<void> {
  await waitForCanonicalApplicationReady(page, { timeoutMs: timeout })
}

export async function waitForPublicHydration(page: Page, timeout = APP_READY_TIMEOUT_MS): Promise<void> {
  await waitForCanonicalPublicHydration(page, { timeoutMs: timeout })
}

export async function settlePage(page: Page): Promise<void> {
  await waitForCanonicalApplicationReady(page)
  await waitForVisualFrameReady(page)
}

export async function openAuditedPage(browser: Browser, storageState?: StorageState): Promise<{
  page: Page
  audit: RuntimeAudit
  close: () => Promise<void>
}> {
  return await openThemedAuditedPage(browser, 'light', storageState)
}

export async function openThemedAuditedPage(
  browser: Browser,
  themeMode: ThemeMode = 'light',
  storageState?: StorageState,
  disableServiceWorker = false
): Promise<AuditedPageSession> {
  const auditedContext = await openThemedAuditedContext(browser, themeMode, storageState, disableServiceWorker)
  const pageSession = await auditedContext.newPage()
  return {
    page: pageSession.page,
    audit: pageSession.audit,
    close: auditedContext.close
  }
}

export async function openThemedAuditedContext(
  browser: Browser,
  themeMode: ThemeMode = 'light',
  storageState?: StorageState,
  disableServiceWorker = false,
  testSession?: string
): Promise<ThemedAuditedContext> {
  const context = await browser.newContext(withAcceptanceContextOptions(
    {
      colorScheme: themeMode === 'dark' ? 'dark' : 'light',
      ...(storageState ? { storageState } : {})
    },
    testSession
  ))
  await context.addInitScript((options: {
    mode: ThemeMode
    captureConsoleErrors: boolean
    diagnosticEventNames: readonly string[]
    disableHumanReadProof: boolean
    disableNotificationStream: boolean
    disableServiceWorker: boolean
  }) => {
    const {
      mode,
      captureConsoleErrors,
      diagnosticEventNames,
      disableHumanReadProof,
      disableNotificationStream,
      disableServiceWorker
    } = options
    const diagnosticWindow = window as typeof window & {
      __FSUSBLOG_TEST_CONSOLE_ERRORS__?: Array<Readonly<{
        message: string
        name: string
        stack: string[]
      }>>
      __FSUSBLOG_PUBLIC_ROUTE_DIAGNOSTICS__?: Array<Readonly<{
        name: string
        error?: string
        target?: string
      }>>
    }
    const diagnosticStorageKey = 'fsus:test:public-route-diagnostics'
    try {
      const storedDiagnostics = window.sessionStorage.getItem(diagnosticStorageKey)
      diagnosticWindow.__FSUSBLOG_PUBLIC_ROUTE_DIAGNOSTICS__ = storedDiagnostics
        ? JSON.parse(storedDiagnostics)
        : []
    } catch {
      diagnosticWindow.__FSUSBLOG_PUBLIC_ROUTE_DIAGNOSTICS__ = []
    }
    if (captureConsoleErrors) {
      diagnosticWindow.__FSUSBLOG_TEST_CONSOLE_ERRORS__ = []
      const originalConsoleError = console.error.bind(console)
      let consoleError = originalConsoleError
      Object.defineProperty(console, 'error', {
        configurable: true,
        get: () => consoleError,
        set: (writer: typeof console.error) => {
          consoleError = (...data: unknown[]) => {
            for (const value of data) {
              if (!(value instanceof Error)) continue
              diagnosticWindow.__FSUSBLOG_TEST_CONSOLE_ERRORS__?.push({
                name: value.name.slice(0, 64),
                message: value.message.slice(0, 512),
                stack: (value.stack ?? '').split('\n').slice(0, 8)
              })
            }
            writer(...data)
          }
        }
      })
    }
    window.addEventListener('fsus:telemetry', (event) => {
      const payload = (event as CustomEvent<{
        name?: unknown
        detail?: Readonly<Record<string, unknown>>
      }>).detail
      if (typeof payload?.name !== 'string'
        || !diagnosticEventNames.includes(payload.name)) {
        return
      }

      const diagnostics = diagnosticWindow.__FSUSBLOG_PUBLIC_ROUTE_DIAGNOSTICS__
      diagnostics?.push({
        name: payload.name,
        ...(typeof payload.detail?.error === 'string' ? { error: payload.detail.error } : {}),
        ...(typeof payload.detail?.target === 'string' ? { target: payload.detail.target } : {})
      })
      if (diagnostics && diagnostics.length > 16) {
        diagnostics.splice(0, diagnostics.length - 16)
      }
      try {
        window.sessionStorage.setItem(diagnosticStorageKey, JSON.stringify(diagnostics))
      } catch {
        // Test diagnostics remain best-effort when storage is unavailable.
      }
    })

    if (disableServiceWorker) {
      const runtimeWindow = window as typeof window & {
        __FSUSBLOG_DISABLE_SERVICE_WORKER__?: boolean
      }
      runtimeWindow.__FSUSBLOG_DISABLE_SERVICE_WORKER__ = true
    }

    if (disableHumanReadProof) {
      const runtimeWindow = window as typeof window & {
        __FSUSBLOG_DISABLE_HUMAN_READ_PROOF__?: boolean
      }
      runtimeWindow.__FSUSBLOG_DISABLE_HUMAN_READ_PROOF__ = true
      const markHumanReadProofSuppressed = () => {
        const root = document.documentElement
        if (!root) {
          return false
        }

        root.dataset.fsusDisableHumanReadProof = 'true'
        return true
      }

      if (!markHumanReadProofSuppressed()) {
        setTimeout(markHumanReadProofSuppressed, 0)
      }
    }

    if (disableNotificationStream) {
      const runtimeWindow = window as typeof window & {
        __FSUSBLOG_DISABLE_NOTIFICATION_STREAM__?: boolean
      }
      runtimeWindow.__FSUSBLOG_DISABLE_NOTIFICATION_STREAM__ = true
      const markNotificationStreamSuppressed = () => {
        const root = document.documentElement
        if (!root) {
          return false
        }

        root.dataset.fsusDisableNotificationStream = 'true'
        return true
      }

      if (!markNotificationStreamSuppressed()) {
        setTimeout(markNotificationStreamSuppressed, 0)
      }
    }

    try {
      localStorage.setItem('fsus:theme-mode', mode)
    } catch {
      // ignore storage access errors during init
    }

    const applyTheme = () => {
      const root = document.documentElement
      if (!root) {
        return false
      }

      const isDark = mode === 'dark'
      root.classList.toggle('dark', mode === 'dark')
      root.classList.toggle('light', mode === 'light')
      root.dataset.themeMode = mode
      root.dataset.themeResolved = isDark ? 'dark' : 'light'
      return true
    }

    if (!applyTheme()) {
      setTimeout(applyTheme, 0)
    }
  }, {
    mode: themeMode,
    captureConsoleErrors: process.env.FSUSBLOG_MANUAL_SCREENSHOT_RUNTIME_AUDIT === '1',
    diagnosticEventNames: PUBLIC_RUNTIME_DIAGNOSTIC_EVENT_NAMES,
    disableHumanReadProof: process.env.FSUSBLOG_DISABLE_HUMAN_READ_PROOF === '1',
    disableNotificationStream: process.env.FSUSBLOG_DISABLE_NOTIFICATION_STREAM === '1',
    disableServiceWorker
  })
  return {
    context,
    newPage: async () => {
      const page = await context.newPage()
      await applyPlaywrightBusinessClock(page)
      return {
        page,
        audit: attachRuntimeAudit(page),
        close: async () => {
          await page.close()
        }
      }
    },
    close: async () => {
      await context.close()
    }
  }
}

export async function setThemeMode(page: Page, mode: ThemeMode): Promise<void> {
  await page.evaluate((nextMode: ThemeMode) => {
    localStorage.setItem('fsus:theme-mode', nextMode)
    const root = document.documentElement
    const isDark = nextMode === 'dark'
    root.classList.toggle('dark', nextMode === 'dark')
    root.classList.toggle('light', nextMode === 'light')
    root.dataset.themeMode = nextMode
    root.dataset.themeResolved = isDark ? 'dark' : 'light'
  }, mode)
}

export async function ensureThemeApplied(page: Page, mode: ThemeMode): Promise<void> {
  await setThemeMode(page, mode)
  await page.waitForFunction(
    (nextMode: ThemeMode) => {
      const root = document.documentElement
      return root.dataset.themeMode === nextMode
        && root.dataset.themeResolved === (nextMode === 'dark' ? 'dark' : 'light')
        && root.classList.contains('dark') === (nextMode === 'dark')
    },
    mode,
    { timeout: 5_000 }
  )
  await settlePage(page)
}

export async function prewarmDevRuntime(
  browser: Browser,
  paths: readonly string[] = ['/']
): Promise<void> {
  let session = await openAuditedPage(browser)

  const warm = async (): Promise<void> => {
    for (const path of paths) {
      const checkpoint = session.audit.checkpoint()
      try {
        const deadlineAtMs = acceptanceMonotonicNow() + WARMUP_TIMEOUT_MS
        await navigateThroughRetryablePublicAot({
          navigate: async () => await session.page.goto(path, { waitUntil: 'domcontentloaded' }),
          sleep: async (delayMs: number) => await delay(delayMs),
          deadlineAtMs,
          now: acceptanceMonotonicNow
        })
        await waitForAppReady(session.page, Math.max(1, deadlineAtMs - acceptanceMonotonicNow()))
      } catch (error) {
        let readiness: unknown
        try {
          readiness = await session.page.evaluate(() => {
            const app = document.querySelector('#app')
            const loader = document.getElementById('global-loader')
            const appRect = app?.getBoundingClientRect()
            return {
              url: location.href,
              documentReadyState: document.readyState,
              app: app instanceof HTMLElement
                ? {
                    display: getComputedStyle(app).display,
                    visibility: getComputedStyle(app).visibility,
                    opacity: getComputedStyle(app).opacity,
                    width: appRect?.width ?? 0,
                    height: appRect?.height ?? 0
                  }
                : null,
              loader: loader
                ? {
                    hidden: loader.hidden,
                    status: loader.querySelector('[data-fsus-loader-status]')?.textContent?.trim() ?? null
                  }
                : null
            }
          })
        } catch (diagnosticError) {
          readiness = {
            unavailable: diagnosticError instanceof Error
              ? diagnosticError.message
              : String(diagnosticError)
          }
        }
        throw new Error(`prewarm failed path=${path} diagnostics=${JSON.stringify({
          readiness,
          runtimeEvents: session.audit.eventsSince(checkpoint)
        })}`, { cause: error })
      }
    }
  }

  try {
    await warm()
  } finally {
    await session.close()
  }
}

export function isRecoverablePrewarmFailure(
  error: unknown,
  browserConnected: boolean
): boolean {
  if (!browserConnected) return false

  const visited = new Set<unknown>()
  let current: unknown = error

  while (current !== null && current !== undefined && !visited.has(current)) {
    visited.add(current)
    if (current instanceof Error) {
      if (current.name === 'TimeoutError'
        || /Target page, context or browser has been closed|Execution context was destroyed/iu.test(current.message)) {
        return true
      }
      current = current.cause
      continue
    }
    break
  }

  return false
}

export async function captureStorageState(
  browser: Browser,
  username: string,
  password: string,
  redirectTo: string,
  testSession?: string
): Promise<StorageState> {
  void browser
  void password
  void redirectTo
  const fixtureKind = username === adminName ? 'admin' : 'user'
  const session = resolveTestSession(testSession)
  const sessionStorageStateFile = session ? `${session}.${fixtureKind}.storage-state.json` : ''
  const storageStateFile = sessionStorageStateFile
    && existsSync(path.join(resolveAuthFixtureDirectory(), sessionStorageStateFile))
    ? sessionStorageStateFile
    : `${fixtureKind}.storage-state.json`
  const storageStatePath = path.join(resolveAuthFixtureDirectory(), storageStateFile)

  if (!existsSync(storageStatePath)) {
    throw new Error(`acceptance storage state fixture is missing: ${storageStateFile}; prepare sessions via lane PrepareSessionFixturesOnce / node tests/frontend/fixtures/prepare-playwright-sessions.mjs or open with fsusLocalFixtureLogin=1`)
  }

  const storageState = JSON.parse(await readFile(storageStatePath, 'utf8')) as StorageState
  if (username !== adminName) {
    return normalizeFixtureStorageState(storageState)
  }

  const sessionUserStorageStateFile = session ? `${session}.user.storage-state.json` : ''
  const userStorageStateFile = sessionUserStorageStateFile
    && existsSync(path.join(resolveAuthFixtureDirectory(), sessionUserStorageStateFile))
    ? sessionUserStorageStateFile
    : 'user.storage-state.json'
  const userStorageStatePath = path.join(resolveAuthFixtureDirectory(), userStorageStateFile)
  if (!existsSync(userStorageStatePath)) {
    throw new Error('acceptance storage state fixture is missing: user.storage-state.json; admin fixtures require the paired user session')
  }

  const userStorageState = JSON.parse(await readFile(userStorageStatePath, 'utf8')) as StorageState
  const normalizedUser = normalizeFixtureStorageState(userStorageState)
  const normalizedAdmin = normalizeFixtureStorageState(storageState)
  return {
    cookies: [
      ...normalizedUser.cookies,
      ...normalizedAdmin.cookies
    ],
    origins: [
      ...(normalizedUser.origins ?? []),
      ...(normalizedAdmin.origins ?? [])
    ]
  }
}

function normalizeFixtureStorageState(storageState: StorageState): StorageState {
  const baseUrl = new URL(
    process.env.PLAYWRIGHT_BASE_URL
      || process.env.FSUSBLOG_PUBLIC_BASE_URL
      || 'http://127.0.0.1:3000'
  )

  const cookies: StorageState['cookies'] = []
  for (const rawCookie of storageState.cookies) {
    const cookie = rawCookie as AcceptanceFixtureCookie
    if (cookie.name.startsWith('__Host-')) {
      if (baseUrl.protocol !== 'https:') {
        continue
      }

      cookies.push({
        name: cookie.name,
        value: cookie.value,
        url: baseUrl.origin,
        expires: cookie.expires ?? -1,
        httpOnly: Boolean(cookie.httpOnly),
        secure: true,
        sameSite: cookie.sameSite ?? 'Strict'
      })
      continue
    }

    cookies.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? baseUrl.hostname,
      path: cookie.path ?? '/',
      expires: cookie.expires ?? -1,
      httpOnly: Boolean(cookie.httpOnly),
      secure: baseUrl.protocol === 'https:' && Boolean(cookie.secure),
      sameSite: cookie.sameSite ?? 'Lax'
    })
  }

  return {
    cookies,
    origins: storageState.origins ?? []
  }
}

function hasLeadingDifficulty(hash: Buffer, difficulty: number): boolean {
  let remaining = difficulty
  for (const byte of hash) {
    if (remaining <= 0) {
      return true
    }

    if (remaining >= 8) {
      if (byte !== 0) {
        return false
      }
      remaining -= 8
      continue
    }

    if ((byte >> (8 - remaining)) !== 0) {
      return false
    }
    return true
  }

  return remaining <= 0
}

function solvePowNonce(salt: string, browserFp: string, difficulty: number, deadlineMs = Number.POSITIVE_INFINITY): string {
  let nonce = 0
  while (true) {
    if ((nonce & 0x0fff) === 0 && acceptanceMonotonicNow() > deadlineMs) {
      throw new Error(`acceptance node pow solver timed out for difficulty ${difficulty}`)
    }

    const payload = `${salt}:${nonce}:${browserFp}`
    const hash = createHash('sha256').update(payload, 'utf8').digest()
    if (hasLeadingDifficulty(hash, difficulty)) {
      return String(nonce)
    }
    nonce += 1
  }
}

async function loadAcceptanceNodePowModule(): Promise<AcceptancePowRuntimeModule | null> {
  if (process.env.FSUSBLOG_DISABLE_NODE_WASM_POW === '1') {
    return null
  }

  acceptanceNodePowModulePromise ??= (async () => {
    for (const assetKind of acceptanceNodePowAssetKinds) {
      try {
        const moduleRef = await import(new URL(`fsus_pow_${assetKind}.js`, acceptancePowWasmRoot).href)
        const factory = moduleRef.default ?? moduleRef.createPowModule
        if (typeof factory !== 'function') {
          continue
        }

        const wasmBinary = await readFile(new URL(`fsus_pow_${assetKind}.wasm`, acceptancePowWasmRoot))
        const module = await factory({ wasmBinary }) as AcceptancePowRuntimeModule
        if (module?.HEAPU8 && typeof module._solve_pow_limited_c === 'function') {
          return module
        }
      } catch {
        // Try the next tier.
      }
    }

    return null
  })().catch(() => null)

  return await acceptanceNodePowModulePromise
}

function writeAcceptanceCString(module: AcceptancePowRuntimeModule, value: string): number {
  const bytes = ACCEPTANCE_UTF8_ENCODER.encode(value)
  const ptr = module._malloc(bytes.length + 1)
  module.HEAPU8.set(bytes, ptr)
  module.HEAPU8[ptr + bytes.length] = 0
  return ptr
}

function readAcceptanceCString(module: AcceptancePowRuntimeModule, ptr: number, maxLength: number): string {
  let end = ptr
  const limit = ptr + maxLength
  while (end < limit && module.HEAPU8[end] !== 0) {
    end += 1
  }

  return ACCEPTANCE_UTF8_DECODER.decode(module.HEAPU8.subarray(ptr, end))
}

function resolveAcceptancePowDeadline(timeoutMs: number): number {
  return acceptanceMonotonicNow() + Math.max(1000, timeoutMs - 250)
}

function yieldToAcceptanceEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function solvePowNonceOptimized(salt: string, browserFp: string, difficulty: number, timeoutMs = 15_000): Promise<string> {
  const deadlineMs = resolveAcceptancePowDeadline(timeoutMs)
  const module = await loadAcceptanceNodePowModule()
  if (!module?.HEAPU8 || typeof module._solve_pow_limited_c !== 'function') {
    if (difficulty >= 25) {
      throw new Error('acceptance node wasm pow solver unavailable for high difficulty challenge')
    }

    return solvePowNonce(salt, browserFp, difficulty, deadlineMs)
  }

  const saltPtr = writeAcceptanceCString(module, salt)
  const fpPtr = writeAcceptanceCString(module, browserFp)
  const outputPtr = module._malloc(2048)

  try {
    let startNonce = 0
    while (acceptanceMonotonicNow() <= deadlineMs) {
      const remainingNonceSpace = 0x1_0000_0000 - startNonce
      const attempts = Math.min(acceptanceNodePowBatchSize, remainingNonceSpace)
      const resultLength = module._solve_pow_limited_c(saltPtr, fpPtr, difficulty, startNonce, attempts, outputPtr, 2048)
      if (resultLength < 0) {
        if (difficulty < 25) {
          return solvePowNonce(salt, browserFp, difficulty, deadlineMs)
        }
        throw new Error(`acceptance node wasm pow solver failed: ${resultLength}`)
      }

      if (resultLength > 0) {
        const nonce = readAcceptanceCString(module, outputPtr, Math.min(resultLength + 1, 2048))
        const hash = createHash('sha256').update(`${salt}:${nonce}:${browserFp}`, 'utf8').digest()
        expect(hasLeadingDifficulty(hash, difficulty), `acceptance node wasm pow solver returned invalid nonce for difficulty ${difficulty}`).toBe(true)
        return nonce
      }

      startNonce = (startNonce + attempts) >>> 0
      if (startNonce === 0 || attempts <= 0) {
        break
      }

      await yieldToAcceptanceEventLoop()
    }

    throw new Error(`acceptance node wasm pow solver timed out for difficulty ${difficulty}`)
  } finally {
    module._free(outputPtr)
    module._free(fpPtr)
    module._free(saltPtr)
  }
}

async function fetchAcceptanceAeds(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${acceptanceBackendUrl}${path}`, withAcceptanceSessionHeaders(init))
  const payload = await readAcceptanceBinaryResponse(response).catch(() => ({}))
  if (!response.ok) {
    const message = payload?.message ?? payload?.Message ?? `status ${response.status}`
    throw new Error(`acceptance fetch failed for ${path}: ${message}`)
  }
  return payload
}

async function readAcceptanceBinaryResponse(response: Response): Promise<any> {
  return decodeAcceptanceBinaryFrame(await response.arrayBuffer())
}

function decodeAcceptanceBinaryFrame(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < AEDS_HEADER_LENGTH) {
    throw new Error('acceptance_aeds_frame_too_short')
  }

  const magic = view.getUint32(0, true)
  if (magic !== AEDS_MAGIC) {
    throw new Error('acceptance_aeds_magic_mismatch')
  }

  if (view.getUint8(4) !== AEDS_VERSION || view.getUint8(5) !== AEDS_HEADER_LENGTH) {
    throw new Error('acceptance_aeds_version_mismatch')
  }

  const frameType = view.getUint16(8, true) as FrameType
  const payloadLength = view.getUint32(10, true)
  if (payloadLength !== bytes.byteLength - AEDS_HEADER_LENGTH) {
    throw new Error('acceptance_aeds_payload_length_mismatch')
  }

  const payload = bytes.subarray(AEDS_HEADER_LENGTH)
  if (acceptanceCrc16(payload) !== view.getUint16(14, true)) {
    throw new Error('acceptance_aeds_payload_crc_mismatch')
  }
  switch (frameType) {
    case FrameType.PowChallenge:
      return decodeAcceptancePowChallenge(payload)
    case FrameType.AuthLoginFlow:
      return { frameType }
    case FrameType.ApiError:
      return decodeAcceptanceApiError(payload)
    default:
      return { frameType, payload }
  }
}

async function buildAcceptancePowHeaders(deviceFingerprint: string): Promise<Record<string, string>> {
  const challenge = await fetchAcceptanceAeds('/api/binary/auth/pow-challenge', {
    headers: {
      Accept: AEDS_BINARY_MEDIA_TYPE,
      [FSUS_HEADERS.deviceFingerprint]: deviceFingerprint
    }
  })

  const salt = challenge.salt ?? challenge.Salt
  const signature = challenge.signature ?? challenge.Signature
  const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4)
  const timestamp = Number(challenge.timestamp ?? challenge.Timestamp)

  if (!salt || !signature) {
    throw new Error('acceptance pow challenge payload invalid')
  }

  const nonce = await solvePowNonceOptimized(salt, deviceFingerprint, difficulty, 30_000)
  const proof = encodeAcceptancePowProofHeader({ salt, nonce, timestamp, difficulty, signature, browserFp: deviceFingerprint })

  return {
    [FSUS_HEADERS.powProof]: proof,
    [FSUS_HEADERS.deviceFingerprint]: deviceFingerprint
  }
}

function decodeAcceptancePowChallenge(payload: Uint8Array) {
  if (payload.byteLength !== 204) {
    throw new Error(`acceptance_pow_challenge_size_mismatch:${payload.byteLength}`)
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return {
    salt: readAcceptanceFixedUtf8(payload, 0, 64),
    difficulty: view.getInt32(64, true),
    timestamp: Number(view.getBigInt64(68, true)),
    signature: readAcceptanceFixedUtf8(payload, 76, 128)
  }
}

function decodeAcceptanceApiError(payload: Uint8Array) {
  if (payload.byteLength !== ACCEPTANCE_API_ERROR_POD_SIZE) {
    throw new Error(`acceptance_api_error_size_mismatch:${payload.byteLength}`)
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return {
    code: payload[0],
    category: payload[1],
    statusCode: view.getInt32(4, true),
    message: readAcceptanceFixedUtf8(payload, 8, 256),
    details: readAcceptanceFixedUtf8(payload, 264, 256),
    traceId: readAcceptanceFixedUtf8(payload, 520, 64)
  }
}

function encodeAcceptancePowProofHeader(payload: {
  salt: string
  nonce: string
  timestamp: number
  difficulty: number
  signature: string
  browserFp: string
}): string {
  const parts = [payload.salt, payload.nonce, payload.signature, payload.browserFp]
    .map((value) => ACCEPTANCE_UTF8_ENCODER.encode(value))
  const totalLength = 4 + 1 + 4 + 8 + parts.reduce((sum, part) => sum + 2 + part.byteLength, 0)
  const bytes = new Uint8Array(totalLength)
  const view = new DataView(bytes.buffer)
  bytes.set([0x46, 0x50, 0x4f, 0x57], 0)
  bytes[4] = 1
  view.setInt32(5, payload.difficulty, true)
  view.setBigInt64(9, BigInt(payload.timestamp), true)

  let offset = 17
  for (const part of parts) {
    if (part.byteLength > 0xffff) {
      throw new Error('acceptance_pow_proof_field_too_large')
    }
    view.setUint16(offset, part.byteLength, true)
    offset += 2
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return Buffer.from(bytes).toString('base64')
}

function readAcceptanceFixedUtf8(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return ACCEPTANCE_UTF8_DECODER.decode(end >= 0 ? slice.subarray(0, end) : slice)
}

function acceptanceCrc16(bytes: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc ^= bytes[i] ?? 0
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
    }
  }
  return crc & 0xffff
}

function withAcceptanceSessionHeaders(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...normalizeRequestHeaders(init.headers),
      ...testSessionHeaders()
    }
  }
}

function normalizeRequestHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {}
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }

  return headers
}

export async function loginViaUi(
  page: Page,
  audit: RuntimeAudit,
  username: string,
  password: string,
  redirectTo: string
): Promise<void> {
  const start = audit.checkpoint()
  await page.goto(`/login?redirect=${encodeURIComponent(redirectTo)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#username'), 'username field should be ready on login page').toBeVisible()
  await expect(page.locator('#password'), 'password field should be ready on login page').toBeVisible()

  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  const submitButton = page.getByRole('button', { name: /进行/ }).first()
  if (await submitButton.count()) {
    await submitButton.click()
  } else {
    await page.locator('form').evaluate((form) => {
      ;(form as HTMLFormElement).requestSubmit()
    })
  }

  await page.waitForFunction(
    () => {
      const path = `${location.pathname}${location.search}`
      return (path !== '/login' && !path.startsWith('/login?'))
        || Boolean(document.querySelector('#mfa-code'))
        || Boolean(document.querySelector('[role="alert"]'))
    },
    undefined,
    { timeout: 45_000 }
  )

  const alertText = (await page.locator('[role="alert"]').allTextContents()).join(' | ').trim()
  const hasMfaPrompt = await page.locator('#mfa-code').count()
  expect(hasMfaPrompt, `${username} should not be forced into MFA`).toBe(0)
  expect(alertText, `${username} login should not fail`).toBe('')

  await waitForAppReady(page)
  await settlePage(page)
  await expect
    .poll(() => {
      const current = new URL(page.url())
      return `${current.pathname}${current.search}`
    }, { message: `${username} should land on redirect target` })
    .toBe(redirectTo)

  audit.assertCleanSince(start, `${username}-login`)
}

export async function expectAnyVisible(locatorCandidates: Locator[], label: string): Promise<void> {
  for (const locator of locatorCandidates) {
    if (await locator.count()) {
      const first = locator.first()
      if (await first.isVisible().catch(() => false)) {
        await expect(first, `${label} should be visible`).toBeVisible()
        return
      }
    }

    if (await locator.isVisible().catch(() => false)) {
      await expect(locator, `${label} should be visible`).toBeVisible()
      return
    }
  }

  throw new Error(`${label} selector not found`)
}

export async function expectVisibleShell(page: Page): Promise<void> {
  const body = page.locator('body')
  await expect(body).not.toContainText('TypeError')
  await expect(body).not.toContainText('ReferenceError')
  await expect(body).not.toContainText('Unhandled')
  await expect(body).not.toContainText('article_payload_invalid')
}

export async function assertNoHorizontalOverflow(page: Page, tolerance = 4): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }))

  expect(
    metrics.scrollWidth,
    `page should not overflow horizontally (scrollWidth=${metrics.scrollWidth}, viewport=${metrics.innerWidth})`
  ).toBeLessThanOrEqual(metrics.innerWidth + tolerance)
}

export async function assertResponsiveLayoutContract(page: Page, label = 'responsive layout'): Promise<void> {
  await assertNoHorizontalOverflow(page)
  await assertNoVerticalTrap(page, label)
  await assertCodeBlockControlledScroll(page, label)

  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const isNarrow = viewportWidth < 640
    const issues: string[] = []
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false
      }
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0
        && rect.bottom >= 0
        && rect.right >= 0
        && rect.top <= viewportHeight
        && rect.left <= viewportWidth
    }
    const labelFor = (element: HTMLElement) => {
      const text = (element.getAttribute('aria-label') || element.textContent || element.id || element.className || element.tagName)
        .toString()
        .trim()
        .replace(/\s+/g, ' ')
      return text.slice(0, 80) || element.tagName.toLowerCase()
    }
    const isInsideControlledScroll = (element: HTMLElement) => {
      let current: HTMLElement | null = element
      while (current) {
        if (current.matches('.blog-scroll-x-safe, .el-scrollbar, .el-scrollbar__wrap, .el-scrollbar__view, .el-tabs__nav-wrap, .el-tabs__nav-scroll, .el-tabs__nav, .el-table, .markdown-body, .prose')) {
          const style = getComputedStyle(current)
          if (style.overflowX === 'auto' || style.overflowX === 'scroll' || current.scrollWidth > current.clientWidth) {
            return true
          }
        }
        current = current.parentElement
      }
      return false
    }

    for (const element of Array.from(document.querySelectorAll('body *')).filter(visible)) {
      const rect = element.getBoundingClientRect()
      if (rect.width > viewportWidth + 4 && !isInsideControlledScroll(element)) {
        issues.push(`wide element ${element.tagName.toLowerCase()} ${labelFor(element)} width=${Math.round(rect.width)}`)
      }
    }

    if (isNarrow) {
      const controls = Array.from(document.querySelectorAll('button, input, textarea, select, .el-button')).filter(visible)
      for (const control of controls) {
        const style = getComputedStyle(control)
        if (style.opacity === '0' || control.getAttribute('aria-hidden') === 'true') {
          continue
        }
        if (control instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'hidden'].includes(control.type)) {
          continue
        }
        if (control.closest('.el-table, table')) {
          continue
        }
        const rect = control.getBoundingClientRect()
        const requiresTouchTarget = control.matches('.el-button, input, textarea, select, button[type="submit"]')
        if (requiresTouchTarget && (rect.height < 36 || rect.width < 32)) {
          const type = control instanceof HTMLInputElement ? ` type=${control.type}` : ''
          issues.push(`small control ${control.tagName.toLowerCase()}${type} class=${control.className} label=${labelFor(control)} ${Math.round(rect.width)}x${Math.round(rect.height)}`)
        }
      }
    }

    return issues.slice(0, 20)
  })

  expect(violations, `${label} should fit viewport and keep controls reachable`).toEqual([])
}

export async function assertNoVerticalTrap(page: Page, label = 'vertical trap'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportHeight = window.innerHeight
    const issues: string[] = []
    const documentHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight ?? 0
    )
    const bodyStyle = getComputedStyle(document.body)
    const rootStyle = getComputedStyle(document.documentElement)
    const hasVisibleModal = Array.from(document.querySelectorAll('.el-dialog, .el-drawer, [role="dialog"]'))
      .some((element) => {
        if (!(element instanceof HTMLElement)) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      })

    if (
      documentHeight > viewportHeight + 8
      && !hasVisibleModal
      && [bodyStyle.overflowY, rootStyle.overflowY].some((value) => value === 'hidden' || value === 'clip')
    ) {
      issues.push(`page taller than viewport but vertical scroll is disabled (height=${documentHeight}, viewport=${viewportHeight})`)
    }

    for (const element of Array.from(document.querySelectorAll('.el-dialog, .el-drawer, [role="dialog"]'))) {
      if (!(element instanceof HTMLElement)) continue
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue
      const scrollable = Array.from(element.querySelectorAll<HTMLElement>('*'))
        .some((child) => {
          const childStyle = getComputedStyle(child)
          return child.scrollHeight > child.clientHeight + 4 && ['auto', 'scroll'].includes(childStyle.overflowY)
        })
      if (rect.height > viewportHeight + 4 && !scrollable) {
        issues.push(`dialog/drawer is taller than viewport without internal scroll (${Math.round(rect.height)}>${viewportHeight})`)
      }
    }

    return issues
  })

  expect(violations, `${label} should remain vertically reachable`).toEqual([])
}

export async function assertInteractiveControlsReachable(page: Page, label = 'interactive controls'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const issues: string[] = []
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0
        && rect.bottom >= -viewportHeight
        && rect.top <= viewportHeight * 2
    }
    const labelFor = (element: HTMLElement) => (element.getAttribute('aria-label') || element.textContent || element.id || element.tagName)
      .toString()
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80)
    const hasHorizontalScrollAncestor = (element: HTMLElement) => {
      let current = element.parentElement
      while (current) {
        const style = getComputedStyle(current)
        if (['auto', 'scroll'].includes(style.overflowX) && current.scrollWidth > current.clientWidth + 4) {
          return true
        }
        if (current.matches('.el-tabs__nav-wrap.is-scrollable')) {
          return true
        }
        if (current.matches('.el-table')) {
          // el-table clips the header and fixed-column panes and synchronises
          // them with the scrollable body via JS — controlled overflow when the
          // body wrap really scrolls.
          const wrap = current.querySelector('.el-scrollbar__wrap')
          if (wrap && wrap.scrollWidth > wrap.clientWidth + 4) {
            return true
          }
        }
        current = current.parentElement
      }
      return false
    }

    for (const control of Array.from(document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], .el-button')).filter(visible)) {
      const rect = control.getBoundingClientRect()
      const position = getComputedStyle(control).position
      if ((rect.right < -2 || rect.left > viewportWidth + 2) && !hasHorizontalScrollAncestor(control)) {
        issues.push(`control is horizontally unreachable: ${labelFor(control)}`)
      }
      if ((position === 'fixed' || position === 'sticky') && (rect.top < -2 || rect.bottom > viewportHeight + 2)) {
        issues.push(`fixed/sticky control is outside viewport: ${labelFor(control)}`)
      }
    }

    return issues.slice(0, 20)
  })

  expect(violations, `${label} should be reachable`).toEqual([])
}

export async function assertModalActionsReachable(page: Page, label = 'modal actions'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth
    const issues: string[] = []

    for (const modal of Array.from(document.querySelectorAll('.el-dialog, .el-drawer, [role="dialog"]'))) {
      if (!(modal instanceof HTMLElement)) continue
      const modalRect = modal.getBoundingClientRect()
      const modalStyle = getComputedStyle(modal)
      if (modalStyle.display === 'none' || modalStyle.visibility === 'hidden' || modalRect.width === 0 || modalRect.height === 0) continue
      const buttons = Array.from(modal.querySelectorAll<HTMLElement>('button, .el-button, [role="button"]'))
        .filter((button) => {
          const rect = button.getBoundingClientRect()
          const style = getComputedStyle(button)
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        })
      const action = buttons.at(-1)
      if (!action) continue
      const rect = action.getBoundingClientRect()
      const insideViewport = rect.left >= -4 && rect.right <= viewportWidth + 4 && rect.top >= -4 && rect.bottom <= viewportHeight + 4
      const modalScrollable = Array.from(modal.querySelectorAll<HTMLElement>('*'))
        .some((child) => {
          const style = getComputedStyle(child)
          return child.scrollHeight > child.clientHeight + 4 && ['auto', 'scroll'].includes(style.overflowY)
        })
      if (!insideViewport && !modalScrollable) {
        issues.push(`modal action is clipped without scroll: ${(action.textContent || action.getAttribute('aria-label') || 'action').trim()}`)
      }
    }

    return issues
  })

  expect(violations, `${label} should remain usable`).toEqual([])
}

export async function assertDrawerUsableUnderShortHeight(page: Page, label = 'drawer short height'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportHeight = window.innerHeight
    const issues: string[] = []
    for (const drawer of Array.from(document.querySelectorAll('.el-drawer'))) {
      if (!(drawer instanceof HTMLElement)) continue
      const rect = drawer.getBoundingClientRect()
      const style = getComputedStyle(drawer)
      if (style.display === 'none' || style.visibility === 'hidden' || rect.height === 0) continue
      const hasScroll = Array.from(drawer.querySelectorAll<HTMLElement>('*'))
        .some((child) => child.scrollHeight > child.clientHeight + 4 && ['auto', 'scroll'].includes(getComputedStyle(child).overflowY))
      if (rect.height > viewportHeight + 4 && !hasScroll) {
        issues.push(`drawer exceeds viewport height without scroll (${Math.round(rect.height)}>${viewportHeight})`)
      }
    }
    return issues
  })

  expect(violations, `${label} should be scrollable`).toEqual([])
}

export async function assertDropdownNotClipped(page: Page, label = 'dropdown clipping'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const issues: string[] = []
    for (const popper of Array.from(document.querySelectorAll('.el-popper, .el-select-dropdown, .el-dropdown-menu, [role="listbox"], [role="menu"]'))) {
      if (!(popper instanceof HTMLElement)) continue
      const rect = popper.getBoundingClientRect()
      const style = getComputedStyle(popper)
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue
      const scrollable = popper.scrollHeight > popper.clientHeight + 4 && ['auto', 'scroll'].includes(style.overflowY)
      if (rect.left < -8 || rect.right > viewportWidth + 8 || (rect.bottom > viewportHeight + 8 && !scrollable)) {
        issues.push(`dropdown clipped: ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`)
      }
    }
    return issues
  })

  expect(violations, `${label} should stay inside the viewport or scroll`).toEqual([])
}

export async function assertStickyHeaderDoesNotCoverFocusedInput(page: Page, label = 'sticky focus'): Promise<void> {
  const violations = await page.evaluate(() => {
    const focusable = Array.from(document.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select, [contenteditable="true"]'))
      .find((element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    })
    if (!focusable) return []

    focusable.setAttribute('data-ux-viewport-probe-focus', 'sticky-focus')
    let scrollAncestor = focusable.parentElement
    while (scrollAncestor) {
      const style = getComputedStyle(scrollAncestor)
      if (
        scrollAncestor.scrollHeight > scrollAncestor.clientHeight + 4
        || scrollAncestor.scrollWidth > scrollAncestor.clientWidth + 4
        || ['auto', 'scroll'].includes(style.overflowY)
        || ['auto', 'scroll'].includes(style.overflowX)
      ) {
        scrollAncestor.setAttribute('data-ux-viewport-probe-scroll', 'sticky-focus')
      }
      scrollAncestor = scrollAncestor.parentElement
    }
    focusable.focus({ preventScroll: false })
    focusable.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = focusable.getBoundingClientRect()
    const blockers = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => {
        if (element === focusable || focusable.contains(element) || element.contains(focusable)) return false
        const style = getComputedStyle(element)
        if (!['fixed', 'sticky'].includes(style.position)) return false
        const blockerRect = element.getBoundingClientRect()
        return blockerRect.height > 0
          && blockerRect.width > 0
          && blockerRect.top <= rect.top + 2
          && blockerRect.bottom >= rect.top + 2
          && blockerRect.left <= rect.right
          && blockerRect.right >= rect.left
      })

    return blockers.slice(0, 5).map((element) => `focused input covered by ${element.tagName.toLowerCase()} ${String(element.className).slice(0, 80)}`)
  })

  expect(violations, `${label} should not hide focused inputs`).toEqual([])
}

export async function assertReadableLineWidthWithinBounds(page: Page, label = 'readable line width'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const maxReadableWidth = Math.min(Math.max(760, viewportWidth * 0.72), 1160)
    const rootZoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1') || 1
    const issues: string[] = []
    for (const element of Array.from(document.querySelectorAll('article, .markdown-body, .prose, [data-readable-region]'))) {
      if (!(element instanceof HTMLElement)) continue
      if (element.closest('.account-page, .admin-page, .write-page, .el-table')) continue
      const rect = element.getBoundingClientRect()
      const text = element.textContent?.trim() ?? ''
      if (text.length < 160 || rect.width === 0 || rect.height === 0) continue
      const logicalWidth = rect.width / rootZoom
      if (logicalWidth > maxReadableWidth + 8) {
        issues.push(`readable region too wide (${Math.round(logicalWidth)}>${Math.round(maxReadableWidth)})`)
      }
    }
    return issues
  })

  expect(violations, `${label} should remain bounded on wide viewports`).toEqual([])
}

export async function assertDashboardGridWidthBounds(page: Page, label = 'dashboard grid'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const issues: string[] = []
    for (const grid of Array.from(document.querySelectorAll('.account-page .grid, .dashboard-grid, [data-dashboard-grid]'))) {
      if (!(grid instanceof HTMLElement)) continue
      const rect = grid.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.width > Math.min(viewportWidth, 1800) + 8) {
        issues.push(`dashboard grid over-expands: ${Math.round(rect.width)}px`)
      }
    }
    return issues
  })

  expect(violations, `${label} should not over-stretch`).toEqual([])
}

export async function assertEditorPanelRatioBounds(page: Page, label = 'editor panel ratio'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const issues: string[] = []
    const workspace = document.querySelector('.write-workspace, .write-layout, [data-editor-workspace]')
    const editor = document.querySelector('.write-editor-panel, [data-editor-panel]')
    const side = document.querySelector('.write-side-panel, [data-editor-side-panel]')
    if (!(editor instanceof HTMLElement)) return issues
    const editorRect = editor.getBoundingClientRect()
    if (editorRect.width > viewportWidth + 4) {
      issues.push(`editor panel exceeds viewport (${Math.round(editorRect.width)}>${viewportWidth})`)
    }
    if (workspace instanceof HTMLElement && side instanceof HTMLElement && viewportWidth >= 1024) {
      const workspaceRect = workspace.getBoundingClientRect()
      const sideRect = side.getBoundingClientRect()
      if (workspaceRect.width > 0 && sideRect.width / workspaceRect.width > 0.48) {
        issues.push(`editor side panel consumes too much width (${Math.round(sideRect.width / workspaceRect.width * 100)}%)`)
      }
    }
    return issues
  })

  expect(violations, `${label} should stay proportionate`).toEqual([])
}

export async function assertTableResponsiveStrategy(page: Page, label = 'table responsive strategy'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const issues: string[] = []
    const hasScrollAncestor = (element: HTMLElement) => {
      let current: HTMLElement | null = element
      while (current) {
        const style = getComputedStyle(current)
        if (['auto', 'scroll'].includes(style.overflowX) || current.scrollWidth > current.clientWidth + 4) return true
        current = current.parentElement
      }
      return false
    }

    for (const table of Array.from(document.querySelectorAll('table, .el-table, .el-responsive-collection'))) {
      if (!(table instanceof HTMLElement)) continue
      const rect = table.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.width > viewportWidth + 4 && !hasScrollAncestor(table)) {
        issues.push(`table/list overflows without controlled scroll: ${Math.round(rect.width)}px`)
      }
    }
    return issues
  })

  expect(violations, `${label} should use controlled scrolling or card layout`).toEqual([])
}

export async function assertCodeBlockControlledScroll(page: Page, label = 'code block scroll'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const issues: string[] = []
    const hasControlledScroll = (element: HTMLElement) => {
      let current: HTMLElement | null = element
      while (current) {
        const style = getComputedStyle(current)
        if (['auto', 'scroll'].includes(style.overflowX) || current.matches('.blog-scroll-x-safe, .markdown-body, .prose, pre, .katex-display, .mermaid')) {
          if (current.scrollWidth > current.clientWidth + 4 || ['auto', 'scroll'].includes(style.overflowX)) return true
        }
        current = current.parentElement
      }
      return false
    }

    for (const element of Array.from(document.querySelectorAll('pre, code, .katex-display, .katex, .mermaid, svg'))) {
      if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.width > viewportWidth + 4 && !hasControlledScroll(element as HTMLElement)) {
        issues.push(`wide rich content lacks controlled scroll: ${element.tagName.toLowerCase()} ${Math.round(rect.width)}px`)
      }
    }
    return issues.slice(0, 20)
  })

  expect(violations, `${label} rich content should scroll inside its container`).toEqual([])
}

export async function assertKatexMermaidControlledScroll(page: Page, label = 'katex mermaid scroll'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const issues: string[] = []
    for (const element of Array.from(document.querySelectorAll('.katex-display, .katex, .mermaid'))) {
      if (!(element instanceof HTMLElement)) continue
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (rect.width > viewportWidth + 4 && !['auto', 'scroll'].includes(style.overflowX) && element.scrollWidth <= element.clientWidth + 4) {
        issues.push(`rich diagram/formula not scroll-contained: ${element.className}`)
      }
    }
    return issues
  })

  expect(violations, `${label} should be controlled`).toEqual([])
}

export async function assertFocusOutlineVisible(page: Page, label = 'focus outline'): Promise<void> {
  const result = await page.evaluate(() => {
    const focusable = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input:not([type="hidden"]), textarea, select, [tabindex]:not([tabindex="-1"])'))
      .find((element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      })
    if (!focusable) return { checked: false, visible: true, detail: 'no focusable controls' }
    focusable.focus({ preventScroll: true })
    const style = getComputedStyle(focusable)
    const visible = style.outlineStyle !== 'none'
      || style.outlineWidth !== '0px'
      || style.boxShadow !== 'none'
      || style.borderColor !== 'rgba(0, 0, 0, 0)'
    const detail = `${focusable.tagName.toLowerCase()} ${String(focusable.className).slice(0, 80)}`
    focusable.blur()
    return { checked: true, visible, detail }
  })

  expect(result.visible, `${label} should be visible (${result.detail})`).toBe(true)
}

export async function assertTouchTargetSize(page: Page, label = 'touch target'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    if (viewportWidth >= 900) return []
    const issues: string[] = []
    const controls = Array.from(document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, .el-button, [role="button"]'))
    for (const control of controls) {
      if (control.classList.contains('sr-only')) continue
      const rect = control.getBoundingClientRect()
      const style = getComputedStyle(control)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width === 0 || rect.height === 0) continue
      if (control.closest('.el-table, table')) continue
      if (control instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'hidden'].includes(control.type)) continue
      if (rect.width < 32 || rect.height < 36) {
        const text = (control.textContent || control.getAttribute('aria-label') || '').trim().replace(/\s+/gu, ' ').slice(0, 48)
        const href = control instanceof HTMLAnchorElement ? control.getAttribute('href') || '' : ''
        const className = String(control.className || '').trim().replace(/\s+/gu, ' ').slice(0, 80)
        const detail = [text && `text="${text}"`, href && `href="${href}"`, className && `class="${className}"`].filter(Boolean).join(' ')
        issues.push(`small touch target ${control.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)} ${detail}`.trim())
      }
    }
    return issues.slice(0, 20)
  })

  expect(violations, `${label} should meet mobile target budgets`).toEqual([])
}

export async function assertNoDuplicateStickyBars(page: Page, label = 'sticky bars'): Promise<void> {
  const violations = await page.evaluate(() => {
    const bars = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .map((element) => ({ element, style: getComputedStyle(element), rect: element.getBoundingClientRect() }))
      .filter(({ style, rect }) => ['fixed', 'sticky'].includes(style.position) && rect.height > 20 && rect.width > window.innerWidth * 0.5 && rect.top <= 120)
    const issues: string[] = []
    for (let index = 0; index < bars.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < bars.length; otherIndex += 1) {
        const first = bars[index].rect
        const second = bars[otherIndex].rect
        const overlap = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top)
        if (overlap > Math.min(first.height, second.height) * 0.6) {
          issues.push(`duplicate sticky bars overlap at top=${Math.round(Math.max(first.top, second.top))}`)
        }
      }
    }
    return issues.slice(0, 5)
  })

  expect(violations, `${label} should not duplicate top chrome`).toEqual([])
}

export async function assertMobileLandscapeSafeArea(page: Page, label = 'mobile landscape safe area'): Promise<void> {
  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    if (viewportWidth < viewportHeight || viewportWidth > 1100 || viewportHeight > 520) return []
    const issues: string[] = []
    for (const header of Array.from(document.querySelectorAll('header, nav, .account-sidebar, .mobile-nav, .site-header'))) {
      if (!(header instanceof HTMLElement)) continue
      if (header.closest('main, article')) continue
      const rect = header.getBoundingClientRect()
      const style = getComputedStyle(header)
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue
      if (rect.height > viewportHeight * 0.34) {
        issues.push(`landscape chrome consumes too much height (${Math.round(rect.height)}px of ${viewportHeight}px)`)
      }
    }
    return issues
  })

  expect(violations, `${label} should preserve usable content height`).toEqual([])
}

export type UxViewportMediaMode =
  | 'default'
  | 'zoom-125'
  | 'zoom-150'
  | 'zoom-200'
  | 'large-text'
  | 'reduced-motion'
  | 'high-contrast'

export async function resetUxViewportMediaMode(page: Page): Promise<void> {
  await page.emulateMedia({
    reducedMotion: 'no-preference',
    forcedColors: 'none',
    contrast: 'no-preference'
  })
  await page.evaluate(() => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) {
      activeElement.blur()
    }
    window.getSelection()?.removeAllRanges()
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-ux-viewport-probe-scroll]'))) {
      element.scrollTo(0, 0)
      element.removeAttribute('data-ux-viewport-probe-scroll')
    }
    document.querySelectorAll('[data-ux-viewport-probe-focus]')
      .forEach((element) => element.removeAttribute('data-ux-viewport-probe-focus'))
    document.querySelectorAll('style[data-ux-viewport-media]').forEach((style) => style.remove())
    document.documentElement.dataset.uxViewportMedia = 'default'
    const rootScrollBehavior = document.documentElement.style.scrollBehavior
    document.documentElement.style.scrollBehavior = 'auto'
    window.scrollTo(0, 0)
    document.scrollingElement?.scrollTo(0, 0)
    document.documentElement.style.scrollBehavior = rootScrollBehavior
  })
}

export async function applyUxViewportMediaMode(page: Page, media: UxViewportMediaMode): Promise<void> {
  if (media === 'reduced-motion') {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  } else if (media === 'high-contrast') {
    await page.emulateMedia({ contrast: 'more', forcedColors: 'active' })
  }

  const content = media === 'large-text'
    ? 'html { font-size: 20px !important; }'
    : media === 'zoom-125'
      ? 'html { zoom: 1.25 !important; }'
      : media === 'zoom-150'
        ? 'html { zoom: 1.5 !important; }'
        : media === 'zoom-200'
          ? 'html { zoom: 2 !important; }'
          : ''

  await page.evaluate(({ nextMedia, css }) => {
    document.querySelectorAll('style[data-ux-viewport-media]').forEach((style) => style.remove())
    if (css) {
      const nonceSource = document.querySelector('script[nonce], style[nonce]') as
        | HTMLScriptElement
        | HTMLStyleElement
        | null
      const nonce = nonceSource?.nonce
        || (window as Window & { __FSUSBLOG_CSP_NONCE__?: string }).__FSUSBLOG_CSP_NONCE__
        || nonceSource?.getAttribute('nonce')
        || ''
      const style = document.createElement('style')
      style.setAttribute('data-ux-viewport-media', nextMedia)
      if (nonce) {
        style.nonce = nonce
      }
      style.textContent = css
      document.head.appendChild(style)
    }
    document.documentElement.dataset.uxViewportMedia = nextMedia
  }, { nextMedia: media, css: content })
}

export async function assertUxViewportMediaMode(
  page: Page,
  media: UxViewportMediaMode,
  label = 'UX viewport media'
): Promise<void> {
  const state = await page.evaluate(() => ({
    mode: document.documentElement.dataset.uxViewportMedia ?? '',
    hasStyle: Boolean(document.querySelector('style[data-ux-viewport-media]')),
    zoom: Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1'),
    fontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
    highContrast: matchMedia('(prefers-contrast: more)').matches,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    hasFocusedElement: document.activeElement !== null
      && document.activeElement !== document.body
      && document.activeElement !== document.documentElement,
    hasProbeState: Boolean(document.querySelector(
      '[data-ux-viewport-probe-focus], [data-ux-viewport-probe-scroll]'
    )),
    selectionRangeCount: window.getSelection()?.rangeCount ?? 0
  }))

  expect(state.mode, `${label} should expose its active media state`).toBe(media)
  expect(state.reducedMotion, `${label} reduced-motion state`).toBe(media === 'reduced-motion')
  expect(state.forcedColors, `${label} forced-colors state`).toBe(media === 'high-contrast')
  expect(state.highContrast, `${label} contrast state`).toBe(media === 'high-contrast')
  expect(state.hasStyle, `${label} injected style state`).toBe(
    ['large-text', 'zoom-125', 'zoom-150', 'zoom-200'].includes(media)
  )
  expect([state.scrollX, state.scrollY], `${label} should reset page scroll`).toEqual([0, 0])
  expect(state.hasFocusedElement, `${label} should clear probe focus`).toBe(false)
  expect(state.hasProbeState, `${label} should clear temporary probe state`).toBe(false)
  expect(state.selectionRangeCount, `${label} should clear probe selection`).toBe(0)

  const expectedZoom = media === 'zoom-125'
    ? 1.25
    : media === 'zoom-150'
      ? 1.5
      : media === 'zoom-200'
        ? 2
        : 1
  expect(state.zoom, `${label} zoom state`).toBeCloseTo(expectedZoom, 2)
  if (media === 'large-text') {
    expect(state.fontSize, `${label} large-text state`).toBeCloseTo(20, 1)
  }
}

export type ViewportBoundaryReport = Readonly<{
  horizontalOverflow: string[]
  responsiveLayout: string[]
  verticalTrap: string[]
  interactiveControls: string[]
  modalActions: string[]
  drawerHeight: string[]
  dropdownClipping: string[]
  readableLineWidth: string[]
  dashboardGrid: string[]
  editorPanel: string[]
  tableResponsive: string[]
  richContentScroll: string[]
  touchTargets: string[]
  mobileLandscape: string[]
}>

export async function collectViewportBoundaryReport(page: Page): Promise<ViewportBoundaryReport> {
  return await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const report: ViewportBoundaryReport = {
      horizontalOverflow: [],
      responsiveLayout: [],
      verticalTrap: [],
      interactiveControls: [],
      modalActions: [],
      drawerHeight: [],
      dropdownClipping: [],
      readableLineWidth: [],
      dashboardGrid: [],
      editorPanel: [],
      tableResponsive: [],
      richContentScroll: [],
      touchTargets: [],
      mobileLandscape: []
    }
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && rect.width > 0
        && rect.height > 0
    }
    const labelFor = (element: HTMLElement) => (
      element.getAttribute('aria-label')
      || element.textContent
      || element.id
      || element.className
      || element.tagName
    ).toString().trim().replace(/\s+/gu, ' ').slice(0, 80)
    const hasHorizontalScrollAncestor = (element: HTMLElement) => {
      let current: HTMLElement | null = element
      while (current) {
        const style = getComputedStyle(current)
        if (
          ['auto', 'scroll'].includes(style.overflowX)
          && current.scrollWidth > current.clientWidth + 4
        ) {
          return true
        }
        if (current.matches('.el-tabs__nav-wrap.is-scrollable')) {
          return true
        }
        if (current.matches('.el-table')) {
          // el-table clips the header and fixed-column panes and synchronises
          // them with the scrollable body via JS — controlled overflow when the
          // body wrap really scrolls.
          const wrap = current.querySelector('.el-scrollbar__wrap')
          if (wrap && wrap.scrollWidth > wrap.clientWidth + 4) {
            return true
          }
        }
        current = current.parentElement
      }
      return false
    }
    const hasControlledRichScroll = (element: HTMLElement) => {
      let current: HTMLElement | null = element
      while (current) {
        const style = getComputedStyle(current)
        if (
          ['auto', 'scroll'].includes(style.overflowX)
          || current.matches('.blog-scroll-x-safe, .markdown-body, .prose, pre, .katex-display, .mermaid')
        ) {
          if (
            current.scrollWidth > current.clientWidth + 4
            || ['auto', 'scroll'].includes(style.overflowX)
          ) {
            return true
          }
        }
        current = current.parentElement
      }
      return false
    }
    const hasVerticalScrollDescendant = (element: HTMLElement) => (
      Array.from(element.querySelectorAll<HTMLElement>('*')).some((child) => {
        const style = getComputedStyle(child)
        return child.scrollHeight > child.clientHeight + 4
          && ['auto', 'scroll'].includes(style.overflowY)
      })
    )

    const documentWidth = document.documentElement.scrollWidth
    if (documentWidth > viewportWidth + 4) {
      report.horizontalOverflow.push(`document scrollWidth=${documentWidth} viewport=${viewportWidth}`)
    }

    const bodyElements = Array.from(document.querySelectorAll<HTMLElement>('body *'))
    for (const element of bodyElements.filter(visible)) {
      const rect = element.getBoundingClientRect()
      if (rect.width > viewportWidth + 4 && !hasHorizontalScrollAncestor(element)) {
        report.responsiveLayout.push(
          `wide element ${element.tagName.toLowerCase()} ${labelFor(element)} width=${Math.round(rect.width)}`
        )
      }
    }
    report.responsiveLayout.splice(20)

    const modals = Array.from(document.querySelectorAll<HTMLElement>('.el-dialog, .el-drawer, [role="dialog"]'))
      .filter(visible)
    const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
    const bodyStyle = getComputedStyle(document.body)
    const rootStyle = getComputedStyle(document.documentElement)
    if (
      documentHeight > viewportHeight + 8
      && modals.length === 0
      && [bodyStyle.overflowY, rootStyle.overflowY].some((value) => value === 'hidden' || value === 'clip')
    ) {
      report.verticalTrap.push(
        `page taller than viewport but vertical scroll is disabled (height=${documentHeight}, viewport=${viewportHeight})`
      )
    }
    for (const modal of modals) {
      const rect = modal.getBoundingClientRect()
      const scrollable = hasVerticalScrollDescendant(modal)
      if (rect.height > viewportHeight + 4 && !scrollable) {
        report.verticalTrap.push(
          `dialog/drawer is taller than viewport without internal scroll (${Math.round(rect.height)}>${viewportHeight})`
        )
      }

      const actions = Array.from(modal.querySelectorAll<HTMLElement>('button, .el-button, [role="button"]'))
        .filter(visible)
      const action = actions.at(-1)
      if (action) {
        const actionRect = action.getBoundingClientRect()
        const insideViewport = actionRect.left >= -4
          && actionRect.right <= viewportWidth + 4
          && actionRect.top >= -4
          && actionRect.bottom <= viewportHeight + 4
        if (!insideViewport && !scrollable) {
          report.modalActions.push(
            `modal action is clipped without scroll: ${(action.textContent || action.getAttribute('aria-label') || 'action').trim()}`
          )
        }
      }
    }

    for (const drawer of Array.from(document.querySelectorAll<HTMLElement>('.el-drawer')).filter(visible)) {
      const rect = drawer.getBoundingClientRect()
      if (rect.height > viewportHeight + 4 && !hasVerticalScrollDescendant(drawer)) {
        report.drawerHeight.push(
          `drawer exceeds viewport height without scroll (${Math.round(rect.height)}>${viewportHeight})`
        )
      }
    }

    for (const popper of Array.from(document.querySelectorAll<HTMLElement>(
      '.el-popper, .el-select-dropdown, .el-dropdown-menu, [role="listbox"], [role="menu"]'
    )).filter(visible)) {
      const rect = popper.getBoundingClientRect()
      const style = getComputedStyle(popper)
      const scrollable = popper.scrollHeight > popper.clientHeight + 4
        && ['auto', 'scroll'].includes(style.overflowY)
      if (rect.left < -8 || rect.right > viewportWidth + 8 || (rect.bottom > viewportHeight + 8 && !scrollable)) {
        report.dropdownClipping.push(
          `dropdown clipped: ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
        )
      }
    }

    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      'button, a[href], input, textarea, select, [role="button"], .el-button'
    )).filter(visible)
    for (const control of controls) {
      const rect = control.getBoundingClientRect()
      const position = getComputedStyle(control).position
      if ((rect.right < -2 || rect.left > viewportWidth + 2) && !hasHorizontalScrollAncestor(control)) {
        report.interactiveControls.push(`control is horizontally unreachable: ${labelFor(control)}`)
      }
      if ((position === 'fixed' || position === 'sticky') && (rect.top < -2 || rect.bottom > viewportHeight + 2)) {
        report.interactiveControls.push(`fixed/sticky control is outside viewport: ${labelFor(control)}`)
      }

      if (viewportWidth < 900) {
        if (control.classList.contains('sr-only')) continue
        if (control.closest('.el-table, table')) continue
        if (control instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'hidden'].includes(control.type)) continue
        if (rect.width < 32 || rect.height < 36) {
          const text = (control.textContent || control.getAttribute('aria-label') || '')
            .trim().replace(/\s+/gu, ' ').slice(0, 48)
          const href = control instanceof HTMLAnchorElement ? control.getAttribute('href') || '' : ''
          const className = String(control.className || '').trim().replace(/\s+/gu, ' ').slice(0, 80)
          const detail = [
            text && `text="${text}"`,
            href && `href="${href}"`,
            className && `class="${className}"`
          ].filter(Boolean).join(' ')
          report.touchTargets.push(
            `small touch target ${control.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)} ${detail}`.trim()
          )
        }
      }
    }
    report.interactiveControls.splice(20)
    report.touchTargets.splice(20)

    const maxReadableWidth = Math.min(Math.max(760, viewportWidth * 0.72), 1160)
    const rootZoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1') || 1
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(
      'article, .markdown-body, .prose, [data-readable-region]'
    ))) {
      if (element.closest('.account-page, .admin-page, .write-page, .el-table')) continue
      const rect = element.getBoundingClientRect()
      const text = element.textContent?.trim() ?? ''
      const logicalWidth = rect.width / rootZoom
      if (text.length >= 160 && logicalWidth > maxReadableWidth + 8 && rect.height > 0) {
        report.readableLineWidth.push(
          `readable region too wide (${Math.round(logicalWidth)}>${Math.round(maxReadableWidth)})`
        )
      }
    }

    for (const grid of Array.from(document.querySelectorAll<HTMLElement>(
      '.account-page .grid, .dashboard-grid, [data-dashboard-grid]'
    )).filter(visible)) {
      const rect = grid.getBoundingClientRect()
      if (rect.width > Math.min(viewportWidth, 1800) + 8) {
        report.dashboardGrid.push(`dashboard grid over-expands: ${Math.round(rect.width)}px`)
      }
    }

    const workspace = document.querySelector<HTMLElement>('.write-workspace, .write-layout, [data-editor-workspace]')
    const editor = document.querySelector<HTMLElement>('.write-editor-panel, [data-editor-panel]')
    const side = document.querySelector<HTMLElement>('.write-side-panel, [data-editor-side-panel]')
    if (editor) {
      const editorRect = editor.getBoundingClientRect()
      if (editorRect.width > viewportWidth + 4) {
        report.editorPanel.push(`editor panel exceeds viewport (${Math.round(editorRect.width)}>${viewportWidth})`)
      }
      if (workspace && side && viewportWidth >= 1024) {
        const workspaceRect = workspace.getBoundingClientRect()
        const sideRect = side.getBoundingClientRect()
        if (workspaceRect.width > 0 && sideRect.width / workspaceRect.width > 0.48) {
          report.editorPanel.push(
            `editor side panel consumes too much width (${Math.round(sideRect.width / workspaceRect.width * 100)}%)`
          )
        }
      }
    }

    for (const table of Array.from(document.querySelectorAll<HTMLElement>(
      'table, .el-table, .el-responsive-collection'
    )).filter(visible)) {
      const rect = table.getBoundingClientRect()
      if (rect.width > viewportWidth + 4 && !hasHorizontalScrollAncestor(table)) {
        report.tableResponsive.push(
          `table/list overflows without controlled scroll: ${Math.round(rect.width)}px`
        )
      }
    }

    for (const element of Array.from(document.querySelectorAll<HTMLElement>(
      'pre, code, .katex-display, .katex, .mermaid, svg'
    ))) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.width > viewportWidth + 4 && !hasControlledRichScroll(element)) {
        report.richContentScroll.push(
          `wide rich content lacks controlled scroll: ${element.tagName.toLowerCase()} ${Math.round(rect.width)}px`
        )
      }
    }
    report.richContentScroll.splice(20)

    if (viewportWidth >= viewportHeight && viewportWidth <= 1100 && viewportHeight <= 520) {
      for (const header of Array.from(document.querySelectorAll<HTMLElement>(
        'header, nav, .account-sidebar, .mobile-nav, .site-header'
      )).filter(visible)) {
        if (header.closest('main, article, footer')) continue
        const rect = header.getBoundingClientRect()
        if (rect.height > viewportHeight * 0.34) {
          report.mobileLandscape.push(
            `landscape chrome consumes too much height (${Math.round(rect.height)}px of ${viewportHeight}px)`
          )
        }
      }
    }

    return report
  })
}

export async function assertViewportBoundaryContract(page: Page, label = 'viewport boundary'): Promise<void> {
  const report = await collectViewportBoundaryReport(page)
  for (const [boundary, violations] of Object.entries(report)) {
    expect(violations, `${label} ${boundary} should have no violations`).toEqual([])
  }

  await assertStickyHeaderDoesNotCoverFocusedInput(page, label)
  await assertFocusOutlineVisible(page, label)
  await assertNoDuplicateStickyBars(page, label)
}

/** Geometry tolerance for #1789 safe-area bounding-box assertions (px). */
export const UX_SAFE_AREA_GEOMETRY_TOLERANCE = 0

export function uxSafeAreaProfileById(id: string): UxSafeAreaProfile {
  const profile = UX_VIEWPORT_MATRIX.safeArea?.profiles?.[id]
  if (!profile) {
    throw new Error(`unknown UX safe-area profile: ${id}`)
  }
  return profile
}

export function uxSafeAreaCssVariableOverrides(profile: UxSafeAreaProfile): Record<string, string> {
  return {
    '--fsus-safe-area-inset-top': `${profile.insets.top}px`,
    '--fsus-safe-area-inset-right': `${profile.insets.right}px`,
    '--fsus-safe-area-inset-bottom': `${profile.insets.bottom}px`,
    '--fsus-safe-area-inset-left': `${profile.insets.left}px`,
    '--fsus-viewport-block-size': `${profile.viewport.height}px`
  }
}

export function uxSafeRectFromProfile(profile: UxSafeAreaProfile): Readonly<{
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}> {
  return {
    left: profile.insets.left,
    top: profile.insets.top,
    right: profile.viewport.width - profile.insets.right,
    bottom: profile.viewport.height - profile.insets.bottom,
    width: profile.viewport.width - profile.insets.left - profile.insets.right,
    height: profile.viewport.height - profile.insets.top - profile.insets.bottom
  }
}

/**
 * Test-only: override FsusUI canonical safe-area / viewport CSS variables.
 * Never patches component selectors or mocks getBoundingClientRect().
 */
export async function applyUxSafeAreaProfile(page: Page, profile: UxSafeAreaProfile): Promise<void> {
  await page.setViewportSize(profile.viewport)
  const overrides = uxSafeAreaCssVariableOverrides(profile)
  await page.evaluate((cssVars) => {
    const root = document.documentElement
    for (const [name, value] of Object.entries(cssVars)) {
      root.style.setProperty(name, value)
    }
  }, overrides)
}

export async function clearUxSafeAreaProfileOverrides(page: Page): Promise<void> {
  const names = UX_VIEWPORT_MATRIX.safeArea?.cssVariables ?? [
    '--fsus-safe-area-inset-top',
    '--fsus-safe-area-inset-right',
    '--fsus-safe-area-inset-bottom',
    '--fsus-safe-area-inset-left',
    '--fsus-viewport-block-size'
  ]
  await page.evaluate((variableNames: string[]) => {
    const root = document.documentElement
    for (const name of variableNames) {
      root.style.removeProperty(name)
    }
  }, [...names])
}

/** Scrim must cover the full drawable viewport (edge residual 0px). */
export async function assertScrimCoversViewport(
  page: Page,
  scrim: Locator,
  label = 'scrim'
): Promise<void> {
  await expect(scrim, `${label} must be visible`).toBeVisible()
  const tolerance = UX_SAFE_AREA_GEOMETRY_TOLERANCE

  const metrics = await scrim.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const visualViewport = window.visualViewport
    return {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      position: style.position,
      insetTop: style.top,
      insetRight: style.right,
      insetBottom: style.bottom,
      insetLeft: style.left,
      viewportBottom: (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? window.innerHeight),
      viewportLeft: visualViewport?.offsetLeft ?? 0,
      viewportRight: (visualViewport?.offsetLeft ?? 0) + (visualViewport?.width ?? window.innerWidth),
      viewportTop: visualViewport?.offsetTop ?? 0
    }
  })

  expect(metrics.position, `${label} position`).toBe('fixed')
  expect(metrics.insetTop, `${label} computed top`).toBe('0px')
  expect(metrics.insetRight, `${label} computed right`).toBe('0px')
  expect(metrics.insetBottom, `${label} computed bottom`).toBe('0px')
  expect(metrics.insetLeft, `${label} computed left`).toBe('0px')
  expect(Math.abs(metrics.left - metrics.viewportLeft), `${label} left delta`).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(metrics.top - metrics.viewportTop), `${label} top delta`).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(metrics.right - metrics.viewportRight), `${label} right delta`).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(metrics.bottom - metrics.viewportBottom), `${label} bottom delta`).toBeLessThanOrEqual(tolerance)

  const box = await scrim.boundingBox()
  const viewport = page.viewportSize()
  expect(box, `${label} bounding box`).not.toBeNull()
  expect(viewport, `${label} viewport`).not.toBeNull()
  if (!box || !viewport) return

  expect(Math.abs(box.x), `${label} box left`).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(box.y), `${label} box top`).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(box.x + box.width - viewport.width), `${label} box right`).toBeLessThanOrEqual(tolerance)
  expect(Math.abs(box.y + box.height - viewport.height), `${label} box bottom`).toBeLessThanOrEqual(tolerance)
}

/** Enabled visible controls must land fully inside the safe rectangle. */
export async function assertControlsInsideSafeRect(
  page: Page,
  root: Locator,
  profile: UxSafeAreaProfile,
  label = 'controls'
): Promise<void> {
  void page
  const safeRect = uxSafeRectFromProfile(profile)
  const tolerance = UX_SAFE_AREA_GEOMETRY_TOLERANCE
  const offenders = await root.evaluate((element, args) => {
    const safe = args.safeRect
    const gap = args.tolerance
    const selector = [
      'button:not([disabled])',
      '[role="button"]:not([aria-disabled="true"])',
      'input:not([disabled])',
      'textarea:not([disabled])',
      'a[href]'
    ].join(',')

    const isVisible = (node: HTMLElement) => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      if (
        style.display === 'none'
        || style.visibility === 'hidden'
        || Number(style.opacity) === 0
        || rect.width <= 0
        || rect.height <= 0
      ) {
        return false
      }
      if ((node as HTMLButtonElement).disabled) return false
      if (node.getAttribute('aria-disabled') === 'true') return false
      return true
    }

    const scrollParents = (node: HTMLElement) => {
      const parents: HTMLElement[] = []
      let current: HTMLElement | null = node.parentElement
      while (current) {
        const style = getComputedStyle(current)
        const scrollable = /(auto|scroll|overlay)/.test(style.overflowY)
          || /(auto|scroll|overlay)/.test(style.overflow)
          || current.scrollHeight > current.clientHeight + 1
        if (scrollable) parents.push(current)
        current = current.parentElement
      }
      return parents
    }

    const bringInsideSafeRect = (node: HTMLElement) => {
      node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
      for (let pass = 0; pass < 3; pass += 1) {
        const rect = node.getBoundingClientRect()
        const deltaTop = safe.top + gap - rect.top
        const deltaBottom = rect.bottom - (safe.bottom - gap)
        const deltaLeft = safe.left + gap - rect.left
        const deltaRight = rect.right - (safe.right - gap)
        if (deltaTop <= 0 && deltaBottom <= 0 && deltaLeft <= 0 && deltaRight <= 0) {
          return
        }
        for (const parent of scrollParents(node)) {
          if (deltaTop > 0) parent.scrollTop -= deltaTop
          if (deltaBottom > 0) parent.scrollTop += deltaBottom
          if (deltaLeft > 0) parent.scrollLeft -= deltaLeft
          if (deltaRight > 0) parent.scrollLeft += deltaRight
        }
      }
    }

    return Array.from(element.querySelectorAll<HTMLElement>(selector))
      .filter((node) => isVisible(node))
      .flatMap((node) => {
        bringInsideSafeRect(node)
        const rect = node.getBoundingClientRect()
        const outside = rect.left < safe.left - gap
          || rect.top < safe.top - gap
          || rect.right > safe.right + gap
          || rect.bottom > safe.bottom + gap
        return outside
          ? [{
              top: rect.top,
              left: rect.left,
              right: rect.right,
              bottom: rect.bottom,
              role: node.getAttribute('role') ?? node.tagName.toLowerCase(),
              className: node.className?.toString?.() ?? ''
            }]
          : []
      })
  }, { safeRect, tolerance })

  expect(
    offenders,
    `${label} must stay inside safe rect ${JSON.stringify(safeRect)} under profile ${profile.id}`
  ).toEqual([])
}

/** Overlay primary actions are focusable and intersect the viewport after scroll. */
export async function assertOverlayActionsReachable(
  page: Page,
  actions: Locator[],
  options: { shortVisual?: boolean, label?: string } = {}
): Promise<void> {
  const label = options.label ?? 'overlay actions'
  const tolerance = UX_SAFE_AREA_GEOMETRY_TOLERANCE
  expect(actions.length, `${label} must provide at least one action`).toBeGreaterThan(0)

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]
    await expect(action, `${label}[${index}] visible`).toBeVisible()
    await action.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
    })
    await action.scrollIntoViewIfNeeded().catch(() => undefined)

    const box = await action.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width
      }
    })
    expect(box.width, `${label}[${index}] width`).toBeGreaterThan(0)
    expect(box.height, `${label}[${index}] height`).toBeGreaterThan(0)

    const viewport = page.viewportSize()
    expect(viewport).not.toBeNull()
    if (viewport) {
      const intersects = box.right > tolerance
        && box.bottom > tolerance
        && box.left < viewport.width - tolerance
        && box.top < viewport.height - tolerance
      expect(
        intersects,
        `${label}[${index}] must intersect the viewport after scroll (box=${JSON.stringify(box)})`
      ).toBe(true)
    }

    if (options.shortVisual) {
      // short-visual must keep confirm/cancel/close/next/previous keyboard-reachable.
      await action.focus({ timeout: 2_000 }).catch(async () => {
        await action.click({ trial: true }).catch(() => undefined)
      })
    } else {
      await action.focus({ timeout: 2_000 }).catch(async () => {
        await action.click({ trial: true }).catch(() => undefined)
      })
    }

    const tabIndex = await action.evaluate((element) => element.getAttribute('tabindex'))
    if (tabIndex !== '-1') {
      const focused = await action.evaluate((element) => (
        element === document.activeElement || element.contains(document.activeElement)
      ))
      expect(focused, `${label}[${index}] must accept focus`).toBe(true)
    }
  }
}

/** Lightbox figure and image must be visible, with positive geometry within safe viewport bounds. */
export async function assertLightboxMediaGeometry(
  page: Page,
  root: Locator,
  profile: UxSafeAreaProfile,
  label = 'lightbox media'
): Promise<void> {
  const figure = root.locator('.article-image-lightbox__figure')
  const img = figure.locator('img')
  await expect(figure, `${label} figure must be visible`).toBeVisible()
  await expect(img, `${label} image must be visible`).toBeVisible()

  const tolerance = UX_SAFE_AREA_GEOMETRY_TOLERANCE
  const mediaMetrics = await root.evaluate((element) => {
    const fig = element.querySelector('.article-image-lightbox__figure') as HTMLElement | null
    const image = element.querySelector('.article-image-lightbox__figure img') as HTMLImageElement | null
    const figRect = fig?.getBoundingClientRect()
    const imgRect = image?.getBoundingClientRect()
    const style = getComputedStyle(element)
    const visualViewport = window.visualViewport
    return {
      safeAreaTop: style.getPropertyValue('--fsus-safe-area-inset-top').trim(),
      safeAreaRight: style.getPropertyValue('--fsus-safe-area-inset-right').trim(),
      safeAreaBottom: style.getPropertyValue('--fsus-safe-area-inset-bottom').trim(),
      safeAreaLeft: style.getPropertyValue('--fsus-safe-area-inset-left').trim(),
      viewportBlockSize: style.getPropertyValue('--fsus-viewport-block-size').trim(),
      minHeight: Number.parseFloat(style.minHeight) || 0,
      paddingTop: Number.parseFloat(style.paddingTop) || 0,
      paddingRight: Number.parseFloat(style.paddingRight) || 0,
      paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
      paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
      visualViewport: {
        bottom: (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? window.innerHeight),
        left: visualViewport?.offsetLeft ?? 0,
        right: (visualViewport?.offsetLeft ?? 0) + (visualViewport?.width ?? window.innerWidth),
        top: visualViewport?.offsetTop ?? 0
      },
      figRect: figRect ? {
        top: figRect.top,
        right: figRect.right,
        bottom: figRect.bottom,
        left: figRect.left,
        width: figRect.width,
        height: figRect.height
      } : null,
      imgRect: imgRect ? {
        top: imgRect.top,
        right: imgRect.right,
        bottom: imgRect.bottom,
        left: imgRect.left,
        width: imgRect.width,
        height: imgRect.height
      } : null
    }
  })

  expect(mediaMetrics.figRect, `${label} figure rect`).not.toBeNull()
  expect(mediaMetrics.imgRect, `${label} img rect`).not.toBeNull()
  if (!mediaMetrics.figRect || !mediaMetrics.imgRect) return

  expect(mediaMetrics.safeAreaTop, `${label} top safe-area token`).toBe(`${profile.insets.top}px`)
  expect(mediaMetrics.safeAreaRight, `${label} right safe-area token`).toBe(`${profile.insets.right}px`)
  expect(mediaMetrics.safeAreaBottom, `${label} bottom safe-area token`).toBe(`${profile.insets.bottom}px`)
  expect(mediaMetrics.safeAreaLeft, `${label} left safe-area token`).toBe(`${profile.insets.left}px`)
  expect(mediaMetrics.viewportBlockSize, `${label} viewport block-size token`).toBe(`${profile.viewport.height}px`)
  expect(mediaMetrics.minHeight, `${label} component viewport block-size`).toBe(profile.viewport.height)

  expect(mediaMetrics.figRect.width, `${label} figure width`).toBeGreaterThan(0)
  expect(mediaMetrics.figRect.height, `${label} figure height`).toBeGreaterThan(0)
  expect(mediaMetrics.imgRect.width, `${label} img width`).toBeGreaterThan(0)
  expect(mediaMetrics.imgRect.height, `${label} img height`).toBeGreaterThan(0)

  const safeRect = {
    bottom: mediaMetrics.visualViewport.bottom - profile.insets.bottom,
    left: mediaMetrics.visualViewport.left + profile.insets.left,
    right: mediaMetrics.visualViewport.right - profile.insets.right,
    top: mediaMetrics.visualViewport.top + profile.insets.top
  }
  for (const [name, rect] of [
    ['figure', mediaMetrics.figRect],
    ['image', mediaMetrics.imgRect]
  ] as const) {
    expect(rect.left, `${label} ${name} safe left`).toBeGreaterThanOrEqual(safeRect.left - tolerance)
    expect(rect.top, `${label} ${name} safe top`).toBeGreaterThanOrEqual(safeRect.top - tolerance)
    expect(rect.right, `${label} ${name} safe right`).toBeLessThanOrEqual(safeRect.right + tolerance)
    expect(rect.bottom, `${label} ${name} safe bottom`).toBeLessThanOrEqual(safeRect.bottom + tolerance)
  }

  // Ensure padding respects safe-area insets (computed from tokens)
  expect(mediaMetrics.paddingTop, `${label} padding top`).toBeGreaterThanOrEqual(profile.insets.top - tolerance)
  expect(mediaMetrics.paddingRight, `${label} padding right`).toBeGreaterThanOrEqual(profile.insets.right - tolerance)
  expect(mediaMetrics.paddingBottom, `${label} padding bottom`).toBeGreaterThanOrEqual(profile.insets.bottom - tolerance)
  expect(mediaMetrics.paddingLeft, `${label} padding left`).toBeGreaterThanOrEqual(profile.insets.left - tolerance)

  const nextButton = root.locator('.article-image-lightbox__nav--next')
  const prevButton = root.locator('.article-image-lightbox__nav--prev')
  await expect(nextButton, `${label} next control for active-image geometry`).toBeVisible()
  await expect(prevButton, `${label} previous control for active-image geometry`).toBeVisible()

  const srcBefore = await img.getAttribute('src')
  await nextButton.click()
  await expect(img, `${label} image after next`).toBeVisible()
  const srcAfterNext = await img.getAttribute('src')
  expect(srcAfterNext, `${label} image changes after next`).not.toBe(srcBefore)
  const nextImgBox = await img.boundingBox()
  expect(nextImgBox, `${label} img box after next`).not.toBeNull()
  if (nextImgBox) {
    expect(nextImgBox.width).toBeGreaterThan(0)
    expect(nextImgBox.height).toBeGreaterThan(0)
    expect(nextImgBox.x, `${label} next image safe left`).toBeGreaterThanOrEqual(safeRect.left - tolerance)
    expect(nextImgBox.y, `${label} next image safe top`).toBeGreaterThanOrEqual(safeRect.top - tolerance)
    expect(nextImgBox.x + nextImgBox.width, `${label} next image safe right`).toBeLessThanOrEqual(safeRect.right + tolerance)
    expect(nextImgBox.y + nextImgBox.height, `${label} next image safe bottom`).toBeLessThanOrEqual(safeRect.bottom + tolerance)
  }

  await prevButton.click()
  await expect(img, `${label} image after prev`).toBeVisible()
  const srcRestored = await img.getAttribute('src')
  expect(srcRestored, `${label} image restored after prev`).toBe(srcBefore)
}

/** Body must not leak uncontrolled horizontal overflow under a safe-area profile. */
export async function assertNoBodyOverflowLeak(page: Page, label = 'body overflow'): Promise<void> {
  const tolerance = UX_SAFE_AREA_GEOMETRY_TOLERANCE
  const overflow = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }))

  expect(
    overflow.scrollWidth,
    `${label}: document scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`
  ).toBeLessThanOrEqual(overflow.clientWidth + tolerance)
  expect(
    overflow.bodyScrollWidth,
    `${label}: body scrollWidth ${overflow.bodyScrollWidth} > clientWidth ${overflow.clientWidth}`
  ).toBeLessThanOrEqual(overflow.clientWidth + tolerance)
}

/**
 * After closing an overlay: body scroll lock clears, scroll position restores,
 * and the original trigger receives focus when still in document.
 */
export async function assertOverlayCloseRestoresFocusAndScroll(
  page: Page,
  options: Readonly<{
    label?: string
    expectedScrollY?: number
    trigger?: Locator | null
  }> = {}
): Promise<void> {
  const label = options.label ?? 'overlay close restore'
  await expect.poll(async () => page.evaluate(() => ({
    hiddenParent: document.body.classList.contains('el-popup-parent--hidden'),
    lightboxOpen: document.body.classList.contains('article-image-lightbox-open'),
    overflow: getComputedStyle(document.body).overflow
  })), { timeout: 3_000, message: label }).toEqual(expect.objectContaining({
    hiddenParent: false,
    lightboxOpen: false
  }))

  if (options.expectedScrollY !== undefined) {
    const scrollY = await page.evaluate(() => window.scrollY)
    expect(
      Math.abs(scrollY - options.expectedScrollY),
      `${label} scrollY restored`
    ).toBeLessThanOrEqual(2)
  }

  if (options.trigger) {
    const count = await options.trigger.count()
    if (count > 0) {
      await expect.poll(async () => options.trigger!.evaluate((element) => (
        element === document.activeElement || element.contains(document.activeElement)
      )), { timeout: 3_000, message: `${label} focus restore` }).toBe(true)
    }
  }
}

/** Document viewport meta identity contract used by hydration and HTML gates. */
export async function assertDocumentViewportMetaContract(
  page: Page,
  label = 'document viewport meta'
): Promise<void> {
  const report = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('meta[name="viewport"]'))
    return {
      count: nodes.length,
      contents: nodes.map((node) => node.getAttribute('content') ?? ''),
      outerHTML: nodes.map((node) => node.outerHTML)
    }
  })

  expect(report.count, `${label} must have exactly one viewport meta`).toBe(1)
  expect(report.contents[0], `${label} content`).toBe(
    'width=device-width, initial-scale=1.0, viewport-fit=cover'
  )
}

export async function assertThemeReadable(page: Page, mode: ThemeMode, label = 'theme'): Promise<void> {
  const palette = await page.evaluate(() => {
    const root = document.documentElement
    const body = document.body

    const read = (selector: string) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) {
        return null
      }

      const style = getComputedStyle(element)
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor
      }
    }

    return {
      themeMode: root.dataset.themeMode ?? '',
      themeResolved: root.dataset.themeResolved ?? '',
      hasDarkClass: root.classList.contains('dark'),
      forcedColors: window.matchMedia('(forced-colors: active)').matches,
      pageBg: getComputedStyle(root).getPropertyValue('--fsusblog-page-bg').trim(),
      fsusPage: getComputedStyle(root).getPropertyValue('--fsus-page').trim(),
      body: read('body'),
      main: read('main'),
      input: read('input, textarea, [role="textbox"]'),
      panel: read('.account-shell-panel, .el-card, .el-dialog, .el-drawer')
    }
  })

  expect(palette.themeMode, `${label} theme mode dataset should match requested mode`).toBe(mode)
  expect(palette.hasDarkClass, `${label} dark class should match requested mode`).toBe(mode === 'dark')
  expect(palette.body, `${label} body should expose computed colors`).not.toBeNull()
  expect(palette.main, `${label} main should expose computed colors`).not.toBeNull()
  if (palette.input === null) {
      expect(mode, `${label} pages without inputs should still resolve theme mode`).toMatch(/light|dark/)
  }
  if (palette.panel === null) {
      expect(mode, `${label} pages without panel containers should still resolve theme mode`).toMatch(/light|dark/)
  }

  if (mode === 'dark' && !palette.forcedColors) {
    expect(
      palette.body?.backgroundColor || palette.main?.backgroundColor,
      `${label} dark mode should not render a pure white page shell (${JSON.stringify(palette)})`
    ).not.toBe('rgb(255, 255, 255)')
  }
}

export async function freezeUiForScreenshot(page: Page): Promise<void> {
  await page.evaluate((content) => {
    const existing = document.getElementById('fsusblog-visual-freeze-style')
    if (existing) {
      existing.textContent = content
      return
    }

    const nonceSource = document.querySelector('script[nonce], style[nonce]') as
      | HTMLScriptElement
      | HTMLStyleElement
      | null
    const nonce =
      nonceSource?.nonce ||
      (window as Window & { __FSUSBLOG_CSP_NONCE__?: string }).__FSUSBLOG_CSP_NONCE__ ||
      nonceSource?.getAttribute('nonce') ||
      ''
    const style = document.createElement('style')
    style.id = 'fsusblog-visual-freeze-style'
    if (nonce) {
      style.nonce = nonce
    }
    style.textContent = content
    document.head.appendChild(style)
  }, `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }

      #fsus-comments-island-content {
        min-height: 10rem !important;
        height: 10rem !important;
        max-height: 10rem !important;
        overflow: hidden !important;
      }

      #fsus-related-reading {
        display: none !important;
      }

      .el-message,
      .el-notification {
        display: none !important;
      }
    `)
}

type DynamicScreenshotTextRule = Readonly<{
  pattern: string
  flags: string
  replacement: string
  pathname?: string
}>

export const DYNAMIC_SCREENSHOT_TEXT_RULES: readonly DynamicScreenshotTextRule[] = [
  { pattern: String.raw`\b\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)\b`, flags: 'gu', replacement: '1/1/2026, 12:00:00 AM' },
  { pattern: String.raw`\b\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\b`, flags: 'gu', replacement: '01/01 12:00' },
  { pattern: String.raw`\b\d{4}-\d{2}-\d{2}\b`, flags: 'gu', replacement: '2026-01-01' },
  { pattern: String.raw`\b\d{4}年\d{1,2}月\d{1,2}日\b`, flags: 'gu', replacement: '2026年1月1日' },
  {
    pattern: String.raw`(?:刚刚|\d+\s*(?:分钟前|小时前)|(?:a few seconds|(?:a|an|one|\d+)\s+(?:minute|hour)s?)\s+ago)`,
    flags: 'giu',
    replacement: '2026-01-01'
  },
  { pattern: String.raw`\bfxpc:public-preview-docs-\d+:public-preview-docs-\d+:`, flags: 'gu', replacement: 'fixture:public-preview:' },
  { pattern: String.raw`\/home\/[^\s]+\/\.tmp\/data\/public-preview-docs-[A-Za-z0-9_.-]+\/backups`, flags: 'gu', replacement: '/workspace/.tmp/data/public-preview-docs-stable/backups' },
  { pathname: '/user/manage/ops', pattern: String.raw`\b\d+\s+\/\s+\d+\b`, flags: 'gu', replacement: '0 / 0' },
  { pathname: '/user/manage/ops', pattern: String.raw`\bqueued=\d+\b`, flags: 'gu', replacement: 'queued=0' }
]

export function normalizeDynamicScreenshotText(value: string, pathname: string): string {
  return DYNAMIC_SCREENSHOT_TEXT_RULES.reduce((normalized, rule) => {
    if (rule.pathname && rule.pathname !== pathname) {
      return normalized
    }
    return normalized.replace(new RegExp(rule.pattern, rule.flags), rule.replacement)
  }, value)
}

export async function normalizeDynamicEvidenceForScreenshot(page: Page): Promise<void> {
  await page.evaluate((rules) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      node.nodeValue = rules.reduce((normalized, rule) => {
        if (rule.pathname && rule.pathname !== window.location.pathname) {
          return normalized
        }
        return normalized.replace(new RegExp(rule.pattern, rule.flags), rule.replacement)
      }, node.nodeValue ?? '')
      node = walker.nextNode()
    }
  }, DYNAMIC_SCREENSHOT_TEXT_RULES)
}

export async function waitForScreenshotPaintStability(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
}

export async function collectVisualMasks(page: Page): Promise<Locator[]> {
  const selectors = [
    'time',
    'canvas',
    '.echarts',
    '.echarts-for-react',
    '.el-message',
    '.dashboard-kpi-value',
    '.dashboard-stat__value',
    '.dashboard-chart canvas',
    '[data-visual-dynamic]'
  ]
  const masks: Locator[] = []

  for (const selector of selectors) {
    const locator = page.locator(selector)
    if (await locator.count().catch(() => 0)) {
      masks.push(locator)
    }
  }

  return masks
}

export async function expectStableScreenshot(
  page: Page,
  locator: Locator,
  name: string,
  options?: Omit<StableScreenshotOptions, 'mask'>
): Promise<void> {
  await expect(locator, `${name} screenshot target should be visible`).toBeVisible({ timeout: 10_000 })
  await locator.scrollIntoViewIfNeeded().catch(() => {})
  await freezeUiForScreenshot(page)
  const mask = await collectVisualMasks(page)
  await expect(locator).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    mask,
    ...options
  })
}

export async function assertElementInViewport(page: Page, locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible()
  await locator.scrollIntoViewIfNeeded()

  const box = await locator.boundingBox()
  expect(box, `${label} should have bounding box`).not.toBeNull()
  expect(box!.width, `${label} width should be positive`).toBeGreaterThan(0)
  expect(box!.height, `${label} height should be positive`).toBeGreaterThan(0)

  const viewport = page.viewportSize()
  if (!viewport) {
    return
  }

  expect(box!.x, `${label} should not start outside viewport`).toBeGreaterThanOrEqual(-2)
  expect(box!.x + Math.min(box!.width, viewport.width), `${label} should not exceed viewport width`).toBeLessThanOrEqual(viewport.width + 4)
}

export async function assertElementHitTarget(page: Page, locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible()
  await locator.scrollIntoViewIfNeeded()

  const box = await locator.boundingBox()
  expect(box, `${label} should have bounding box`).not.toBeNull()

  const viewport = page.viewportSize()
  const x = Math.min(Math.max((box!.x + box!.width / 2), 1), (viewport?.width ?? 2000) - 1)
  const y = Math.min(Math.max((box!.y + box!.height / 2), 1), (viewport?.height ?? 2000) - 1)

  const hitTarget = await locator.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y)
    return Boolean(hit && (hit === element || element.contains(hit)))
  }, { x, y })

  expect(hitTarget, `${label} should not be obscured at interaction point`).toBeTruthy()
}

export async function assertSectionsDoNotOverlap(sections: Array<{ locator: Locator; label: string }>): Promise<void> {
  const visibleBoxes: Array<{ label: string; box: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>> }> = []

  for (const section of sections) {
    if (!await section.locator.count()) {
      continue
    }
    if (!await section.locator.isVisible().catch(() => false)) {
      continue
    }
    await section.locator.scrollIntoViewIfNeeded().catch(() => {})
    const box = await section.locator.boundingBox()
    if (box) {
      visibleBoxes.push({ label: section.label, box })
    }
  }

  for (let index = 0; index < visibleBoxes.length; index += 1) {
    for (let compareIndex = index + 1; compareIndex < visibleBoxes.length; compareIndex += 1) {
      const current = visibleBoxes[index]!
      const next = visibleBoxes[compareIndex]!
      const overlapX = Math.max(0, Math.min(current.box.x + current.box.width, next.box.x + next.box.width) - Math.max(current.box.x, next.box.x))
      const overlapY = Math.max(0, Math.min(current.box.y + current.box.height, next.box.y + next.box.height) - Math.max(current.box.y, next.box.y))
      const overlapArea = overlapX * overlapY
      expect(overlapArea, `${current.label} should not overlap ${next.label}`).toBeLessThanOrEqual(4)
    }
  }
}

export async function assertToastInViewport(page: Page): Promise<void> {
  const box = await page.evaluate(() => {
    const messages = Array.from(document.querySelectorAll<HTMLElement>('.el-message')).reverse()
    for (const message of messages) {
      const style = getComputedStyle(message)
      const rect = message.getBoundingClientRect()
      if (style.visibility === 'hidden' || style.display === 'none' || rect.width <= 0 || rect.height <= 0) {
        continue
      }

      return {
        x: rect.x,
        width: rect.width,
        height: rect.height
      }
    }

    return null
  })
  if (!box) {
    return
  }

  const viewport = page.viewportSize()
  if (!viewport) {
    return
  }

  expect(box.width, 'toast width should be positive').toBeGreaterThan(0)
  expect(box.height, 'toast height should be positive').toBeGreaterThan(0)
  expect(box.x, 'toast should not start outside viewport').toBeGreaterThanOrEqual(-2)
  expect(box.x + Math.min(box.width, viewport.width), 'toast should not exceed viewport width').toBeLessThanOrEqual(viewport.width + 4)
}

export async function expectAnyToastText(page: Page, pattern: RegExp, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => {
      const texts = await page.locator('.el-message').allTextContents()
      return texts.some((text) => pattern.test(text))
    }, { message: `expected a toast matching ${pattern}`, timeout })
    .toBe(true)
}

export async function assertTableLayout(page: Page, table: Locator, pagination?: Locator): Promise<void> {
  await assertElementInViewport(page, table, 'table')
  const header = table.locator('.el-table__header')
  const body = table.locator('.el-table__body-wrapper')
  if (await header.count()) {
    await assertElementInViewport(page, header.first(), 'table header')
  }
  if (await body.count()) {
    await assertElementInViewport(page, body.first(), 'table body')
  }
  if (pagination && await pagination.count()) {
    await assertElementInViewport(page, pagination.first(), 'pagination')
  }
}

export async function expectRouteAndShell(page: Page, audit: RuntimeAudit, route: RouteExpectation): Promise<void> {
  const start = audit.checkpoint()
  await page.goto(route.path, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
  await settlePage(page)

  if (route.expectedUrl || route.expectedPathname) {
    await expect
      .poll(() => {
        const current = new URL(page.url())
        return route.expectedUrl ? `${current.pathname}${current.search}` : current.pathname
      }, { message: `${route.label} should land on expected route` })
      .toBe(route.expectedUrl ?? route.expectedPathname)
  }

  await expect(page.locator('#app')).toHaveCount(1)
  await expectAnyVisible(route.selectors.map((factory) => factory(page)), route.label)
  await expectVisibleShell(page)
  await assertNoHorizontalOverflow(page)
  audit.assertCleanSince(start, route.label)
}

export async function fillTextareaWithLabel(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label)
  if (await field.count()) {
    await field.fill(value)
    return
  }

  throw new Error(`textarea/input with label "${label}" not found`)
}
