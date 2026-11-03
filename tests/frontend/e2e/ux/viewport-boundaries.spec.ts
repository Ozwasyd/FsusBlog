import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Browser, Locator, Page, TestInfo } from '@playwright/test'
import {
  UX_CONTENT_BOUNDARY_CORPUS,
  UX_VIEWPORT_MATRIX,
  type AuditedPageSession,
  type StorageState,
  type ThemeMode,
  type UxSafeAreaProfile,
  type UxViewport,
  type UxViewportMediaMode,
  type UxViewportMode,
  adminName,
  adminPassword,
  applyUxSafeAreaProfile,
  applyUxViewportMediaMode,
  assertControlsInsideSafeRect,
  assertDocumentViewportMetaContract,
  assertLightboxMediaGeometry,
  assertNoBodyOverflowLeak,
  assertOverlayActionsReachable,
  assertOverlayCloseRestoresFocusAndScroll,
  assertScrimCoversViewport,
  assertThemeReadable,
  assertUxViewportMediaMode,
  assertViewportBoundaryContract,
  captureStorageState,
  clearUxSafeAreaProfileOverrides,
  fixtures,
  freezeUiForScreenshot,
  openThemedAuditedContext,
  resetUxViewportMediaMode,
  settlePage,
  userName,
  userPassword,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import {
  buildAdminRoutes,
  buildAnonymousRoutes,
  buildUserRoutes
} from '../../support/playwright/routeAuditMatrix'
import {
  UX_VIEWPORT_MODEL_ROUTE_IDS,
  buildUxViewportPlan
} from '../../support/playwright/uxViewportPlan.mjs'
import { installArticleLightboxProductionSurface } from '../../support/playwright/articleLightboxProductionSurface'
// @ts-ignore The retry helper is a pure module covered by node:test.
import { navigateThroughRetryablePublicAot } from '../../support/playwright/publicAotNavigationRetry.mjs'
// @ts-ignore The risk-only settle helper intentionally stays a pure module covered by node:test.
import { settleUxViewportRiskPage } from '../../support/playwright/uxViewportRiskSettle.mjs'
// @ts-ignore Shared runtime browser budgets are exercised by node:test.
import { resolveRuntimeBrowserTimeoutPlan } from '../../support/runtime-browser-timeout.mjs'
// @ts-ignore The progress store intentionally stays a pure Node module shared with node:test.
import { openUxViewportProgress, recordUxViewportGroupResult } from '../../support/playwright/uxViewportProgress.mjs'

type StorageKind = 'anonymous' | 'user' | 'admin'

type UxRoute = Readonly<{
  id: string
  path: string
  expectedUrl: string
  expectedQuery?: Readonly<Record<string, string>>
  allowQuery?: boolean
  storage: StorageKind
  injectCorpus: boolean
  screenshotSelector: string
}>

type PlannedStep = Readonly<{
  id: string
  media: UxViewportMediaMode
}>

type PlannedViewport = Readonly<{
  id: string
  viewport: UxViewport
  steps: PlannedStep[]
}>

type PlannedGroup = Readonly<{
  id: string
  kind?: 'route-theme' | 'safe-area'
  route: UxRoute
  theme: ThemeMode
  storage: StorageKind
  browser?: string
  surface?: Readonly<{
    id: string
    surface: string
    open: string
    overlayRisk: boolean
  }>
  profile?: UxSafeAreaProfile
  viewports: PlannedViewport[]
}>

type UxPlan = Readonly<{
  mode: UxViewportMode
  fingerprint: string
  groups: PlannedGroup[]
  counts: Readonly<{
    routes: number
    routeThemeGroups: number
    safeAreaGroups?: number
    navigations: number
    cases: number
    safeAreaCases?: number
  }>
}>

type UxRiskTimingRecorder = ReturnType<typeof createUxRiskTimingRecorder>

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const mode = parseMode(process.env.FSUSBLOG_UX_VIEWPORT_MODE)
const modeConfig = UX_VIEWPORT_MATRIX.modes[mode]
const screenshotsEnabled = modeConfig.screenshots === true
  || readBooleanFlag('FSUSBLOG_UX_VIEWPORT_SCREENSHOTS')
const parityBatch = readBooleanFlag('FSUSBLOG_UX_VIEWPORT_PARITY_BATCH')
const usesIsolatedSessions = process.env.FSUSBLOG_TEST_SESSION_ISOLATION === '1'
const viewportExecutionMode = mode === 'smoke' || usesIsolatedSessions
  ? 'parallel'
  : 'default'
const resume = false
const riskMatrix = readBooleanFlag('FSUSBLOG_UX_VIEWPORT_RISK_MATRIX')
const runtimeBrowserTimeoutPlan = resolveRuntimeBrowserTimeoutPlan()
const riskAppReadyTimeoutMs = riskMatrix
  ? runtimeBrowserTimeoutPlan.requestTimeoutMs * 2
  : undefined
const publicAotNavigationWindowMs = runtimeBrowserTimeoutPlan.requestTimeoutMs * 2
const riskPublicBaseUrl = riskMatrix
  ? readOptionalHttpUrl('FSUSBLOG_UX_VIEWPORT_PUBLIC_BASE_URL')
  : undefined
const executionGroupIds = new Set(readOptionalList('FSUSBLOG_UX_VIEWPORT_EXECUTION_GROUP_IDS') ?? [])
const persistentWorkerMode = readBooleanFlag('FSUSBLOG_UX_VIEWPORT_PERSISTENT_WORKER')
const uxRoutes = buildUxRoutes()
assertRuntimeRouteCatalog(uxRoutes)
const plan = buildUxViewportPlan({
  matrix: UX_VIEWPORT_MATRIX,
  routes: uxRoutes,
  mode,
  filters: {
    routeIds: readOptionalList('FSUSBLOG_UX_VIEWPORT_ROUTE_IDS'),
    themes: readOptionalList('FSUSBLOG_UX_VIEWPORT_THEMES'),
    viewportIds: readOptionalList('FSUSBLOG_UX_VIEWPORT_VIEWPORTS'),
    media: readOptionalList('FSUSBLOG_UX_VIEWPORT_MEDIA'),
    riskMatrix
  }
}) as UxPlan
const progressRun = await openUxViewportProgress({
  root: repositoryRoot,
  plan,
  resume,
  runId: process.env.FSUSBLOG_UX_VIEWPORT_RUN_ID,
  runToken: process.env.FSUSBLOG_UX_VIEWPORT_RUN_TOKEN,
  outputDir: process.env.FSUSBLOG_UX_VIEWPORT_CURRENT_OUTPUT_DIR
})
const screenshotRoot = path.join(
  repositoryRoot,
  progressRun.progress.artifacts.root,
  'screenshots'
)

const userStorageStates = new WeakMap<Browser, Promise<StorageState>>()
const adminStorageStates = new WeakMap<Browser, Promise<StorageState>>()

const plannedTestGroups = parityBatch
  ? plan.groups.flatMap((group) => group.viewports.flatMap((viewportPlan) => (
      viewportPlan.steps.map((step) => ({
        ...group,
        id: step.id,
        viewports: [{ ...viewportPlan, steps: [step] }]
      }))
    )))
  : plan.groups
const testGroups = executionGroupIds.size > 0
  ? plannedTestGroups.filter((group) => executionGroupIds.has(group.id))
  : plannedTestGroups
if (executionGroupIds.size > 0) {
  const selectedIds = new Set(testGroups.map((group) => group.id))
  const missing = [...executionGroupIds].filter((groupId) => !selectedIds.has(groupId))
  if (missing.length > 0 || testGroups.length === 0) {
    throw new Error(`unknown UX viewport execution groups: ${missing.join(', ')}`)
  }
}

if (!persistentWorkerMode) test.describe(`UX viewport boundaries (${mode})`, () => {
  test.describe.configure({
    mode: viewportExecutionMode
  })

  for (const group of testGroups) {
    test(group.id, async ({ browser }, testInfo) => {
      test.skip(
        resume && progressRun.completedGroupIds.has(group.id),
        `completed by UX viewport run ${progressRun.progress.runId}`
      )

      if (group.kind === 'safe-area') {
        if (group.browser && testInfo.project.name !== group.browser) {
          // Soft project filter when multiple browsers are configured.
          // Summary/release gate still fails if required WebKit results are missing.
          test.skip(true, `safe-area case requires browser project ${group.browser}`)
        }
      } else if (
        testInfo.project.name !== 'chromium'
        && process.env.FSUSBLOG_UX_VIEWPORT_ALL_BROWSERS !== '1'
      ) {
        // Route-theme coverage stays chromium-primary so enabling WebKit for
        // safe-area cases does not double the full #54 matrix wall-clock budget.
        test.skip(
          true,
          'route-theme UX viewport groups run on chromium unless FSUSBLOG_UX_VIEWPORT_ALL_BROWSERS=1'
        )
      }

      const timing = createUxRiskTimingRecorder(group, riskMatrix)
      let groupError: unknown = null
      try {
        if (group.kind === 'safe-area') {
          await runUxSafeAreaGroup(browser, group, timing)
        } else {
          await runUxRouteThemeGroup(browser, group, timing)
        }
      } catch (error) {
        groupError = error
        if (!parityBatch) {
          await recordUxViewportGroupResult({
            run: progressRun,
            plan,
            groupId: group.id,
            status: 'failed',
            error,
            artifacts: currentTestArtifacts(testInfo)
          })
        }
        throw error
      } finally {
        await publishUxRiskTiming(timing, testInfo, groupError)
      }

      if (!parityBatch) {
        await recordUxViewportGroupResult({
          run: progressRun,
          plan,
          groupId: group.id,
          status: 'passed',
          artifacts: currentTestArtifacts(testInfo)
        })
      }
    })
  }
})

export async function runPersistentUxViewportGroup(
  browser: Browser,
  groupId: string,
  options: Readonly<{ outputDir: string, workerIndex: number, attempt: number, sessionId: string }>
): Promise<Readonly<Record<string, unknown>>> {
  if (!persistentWorkerMode) {
    throw new Error('persistent UX group runner requires FSUSBLOG_UX_VIEWPORT_PERSISTENT_WORKER=1')
  }
  const group = plannedTestGroups.find((candidate) => candidate.id === groupId)
  if (!group) throw new Error(`unknown persistent UX viewport group: ${groupId}`)
  if (progressRun.completedGroupIds.has(group.id)) {
    return {
      status: 'already-passed',
      groupId: group.id,
      logicalTestId: logicalTestId(group),
      workerIndex: options.workerIndex,
      attempt: options.attempt,
      sessionId: options.sessionId,
      exactOnceReceipt: true
    }
  }

  await mkdir(options.outputDir, { recursive: true })
  const timing = createUxRiskTimingRecorder(group, riskMatrix)
  try {
    if (group.kind === 'safe-area') {
      await runUxSafeAreaGroup(browser, group, timing, options.outputDir, options.sessionId)
    } else {
      await runUxRouteThemeGroup(browser, group, timing, options.outputDir, options.sessionId)
    }
  } catch (error) {
    const artifact = await writePersistentGroupArtifact(group, options, timing.summary(error))
    const artifacts = [artifact, ...await presentPersistentFailureArtifacts(options.outputDir)]
    await recordUxViewportGroupResult({
      run: progressRun,
      plan,
      groupId: group.id,
      status: 'failed',
      error,
      artifacts
    })
    throw error
  }

  const timingSummary = timing.summary(null)
  const artifact = await writePersistentGroupArtifact(group, options, timingSummary)
  const artifacts = [artifact, ...persistentScreenshotArtifacts(group)]
  await recordUxViewportGroupResult({
    run: progressRun,
    plan,
    groupId: group.id,
    status: 'passed',
    artifacts
  })
  return {
    status: 'passed',
    groupId: group.id,
    logicalTestId: logicalTestId(group),
    caseTestIds: group.viewports.flatMap((viewport) => viewport.steps.map((step) => step.id)),
    workerIndex: options.workerIndex,
    attempt: options.attempt,
    sessionId: options.sessionId,
    timing: timingSummary,
    artifacts
  }
}

async function presentPersistentFailureArtifacts(outputDir: string): Promise<string[]> {
  const screenshot = path.join(outputDir, 'failure.png')
  try {
    await access(screenshot)
    return [path.relative(repositoryRoot, screenshot).replaceAll(path.sep, '/')]
  } catch {
    return []
  }
}

export function persistentUxViewportRuntimeMetadata(): Readonly<Record<string, unknown>> {
  return {
    mode,
    planFingerprint: plan.fingerprint,
    plannedGroupIds: plannedTestGroups.map((group) => group.id),
    counts: plan.counts,
    runId: progressRun.progress.runId,
    completedGroupIds: [...progressRun.completedGroupIds]
  }
}

async function writePersistentGroupArtifact(
  group: PlannedGroup,
  options: Readonly<{ outputDir: string, workerIndex: number, attempt: number, sessionId: string }>,
  timing: Readonly<Record<string, unknown>>
): Promise<string> {
  const file = path.join(options.outputDir, 'group-result.json')
  await writeFile(file, `${JSON.stringify({
    schema: 'fsusblog.ux-risk.persistent-group.v1',
    groupId: group.id,
    logicalTestId: logicalTestId(group),
    caseTestIds: group.viewports.flatMap((viewport) => viewport.steps.map((step) => step.id)),
    workerIndex: options.workerIndex,
    attempt: options.attempt,
    sessionNamespace: `${options.sessionId}:context:${group.id}:attempt-${options.attempt}`,
    timing,
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`)
  return path.relative(repositoryRoot, file).replaceAll(path.sep, '/')
}

function persistentScreenshotArtifacts(group: PlannedGroup): string[] {
  if (!screenshotsEnabled) return []
  return group.viewports.map((viewportPlan) => path.relative(repositoryRoot, path.join(
    screenshotRoot,
    viewportPlan.viewport.name,
    group.theme,
    `${sanitizeFilename(group.route.id)}.png`
  )).replaceAll(path.sep, '/'))
}

function logicalTestId(group: PlannedGroup): string {
  return `UX viewport boundaries (${mode}) › ${group.id}`
}

function parseMode(value: string | undefined): UxViewportMode {
  if (!value || value === 'smoke') {
    return 'smoke'
  }
  if (value === 'visual' || value === 'boundaries') {
    return value
  }
  throw new Error(`unknown UX viewport mode: ${value}`)
}

function readBooleanFlag(name: string): boolean {
  const value = process.env[name]
  if (!value || value === '0') {
    return false
  }
  if (value === '1') {
    return true
  }
  throw new Error(`unknown UX viewport boolean filter ${name}: ${value}`)
}

function readOptionalList(name: string): string[] | undefined {
  const raw = process.env[name]
  if (raw === undefined) {
    return undefined
  }
  return raw.split(',').map((value) => value.trim()).filter(Boolean)
}

function readOptionalHttpUrl(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use http or https`)
  }
  return url.href
}

function buildUxRoutes(): UxRoute[] {
  const publicRoutes = buildAnonymousRoutes(fixtures).map((route) => ({
    id: `public-${route.name}`,
    path: route.path,
    expectedUrl: route.expectedUrl,
    storage: 'anonymous' as const,
    injectCorpus: ['home', 'article', 'search', 'category', 'tag', 'about'].includes(route.name),
    screenshotSelector: route.name === 'article' ? 'article, main' : 'main'
  }))

  const userRoutes = buildUserRoutes().map((route) => ({
    id: route.name,
    path: route.path,
    expectedUrl: route.expectedUrl,
    allowQuery: route.name === 'user-messagebox',
    storage: 'user' as const,
    injectCorpus: ['user-profile', 'user-comments', 'user-messagebox'].includes(route.name),
    screenshotSelector: route.name === 'user-messagebox' ? '.messages-list-pane, main' : 'main'
  }))

  const adminRoutes = buildAdminRoutes(fixtures).map((route) => ({
    id: route.name,
    path: route.path,
    expectedUrl: route.expectedUrl,
    expectedQuery: route.name === 'manage-list' ? { page: '1', size: '10' } : undefined,
    allowQuery: route.name === 'manage-message',
    storage: 'admin' as const,
    injectCorpus: ['manage-dashboard', 'manage-write', 'manage-list', 'manage-settings', 'manage-users', 'manage-message'].includes(route.name),
    screenshotSelector: route.name === 'manage-write' ? '.write-editor-panel, main' : 'main'
  }))

  return [...publicRoutes, ...userRoutes, ...adminRoutes]
}

function assertRuntimeRouteCatalog(routes: UxRoute[]): void {
  const actual = routes.map((route) => route.id)
  const expected = [...UX_VIEWPORT_MODEL_ROUTE_IDS]
  if (actual.length !== expected.length || actual.some((routeId, index) => routeId !== expected[index])) {
    throw new Error(`UX viewport runtime route catalog drift: actual=${actual.join(',')} expected=${expected.join(',')}`)
  }
}

async function runUxRouteThemeGroup(
  browser: Browser,
  group: PlannedGroup,
  timing: UxRiskTimingRecorder,
  failureOutputDir?: string,
  testSession?: string
): Promise<void> {
  const storageState = await timing.measure(
    'fixture.storage-state',
    group.storage,
    () => storageStateFor(browser, group.storage, testSession)
  )
  const auditedContext = await timing.measure(
    'context.open',
    group.id,
    () => openThemedAuditedContext(browser, group.theme, storageState, riskMatrix || storageState !== undefined, testSession)
  )
  try {
    const pageSession = await timing.measure(
      'page.open',
      group.id,
      () => auditedContext.newPage()
    )
    try {
      let isolationSeeded = false
      for (const viewportPlan of group.viewports) {
      await timing.measure('page.viewport-and-reset', viewportPlan.id, async () => {
        await pageSession.page.setViewportSize({
          width: viewportPlan.viewport.width,
          height: viewportPlan.viewport.height
        })
        await resetUxViewportMediaMode(pageSession.page)
        await assertUxViewportMediaMode(
          pageSession.page,
          'default',
          `${viewportPlan.id} pre-navigation reset`
        )
      })

      let navigationAuditStart = timing.measureSync(
        'audit.checkpoint',
        `${viewportPlan.id}:navigation`,
        () => pageSession.audit.checkpoint()
      )
      const navigationTarget = riskPublicBaseUrl && group.storage === 'anonymous'
        ? new URL(group.route.path, riskPublicBaseUrl).href
        : group.route.path
      await timing.measure(
        'navigation.goto',
        viewportPlan.id,
        () => group.storage === 'anonymous'
          ? navigateThroughRetryablePublicAot({
              navigate: () => pageSession.page.goto(navigationTarget, { waitUntil: 'domcontentloaded' }),
              sleep: (delayMs: number) => pageSession.page.waitForTimeout(delayMs),
              deadlineAtMs: Date.now() + publicAotNavigationWindowMs,
              onRetryableResponse: () => {
                navigationAuditStart = timing.measureSync(
                  'audit.checkpoint',
                  `${viewportPlan.id}:retryable-public-aot`,
                  () => pageSession.audit.checkpoint()
                )
              }
            })
          : pageSession.page.goto(navigationTarget, { waitUntil: 'domcontentloaded' })
      )
      await timing.measure(
        'navigation.app-ready',
        viewportPlan.id,
        () => waitForUxViewportAppReady(pageSession.page, timing, viewportPlan.id)
      )
      if (persistentWorkerMode && !isolationSeeded) {
        await timing.measure(
          'context.isolation-probe',
          group.id,
          () => assertAndSeedPersistentContextIsolation(pageSession.page, group.id)
        )
        isolationSeeded = true
      }
      await settleUxViewportPage(pageSession.page, timing, 'navigation', viewportPlan.id)
      if (group.route.injectCorpus) {
        await timing.measure(
          'corpus.inject',
          viewportPlan.id,
          () => injectContentBoundaryCorpus(pageSession.page)
        )
        await settleUxViewportPage(pageSession.page, timing, 'corpus', viewportPlan.id)
      }

      let includesNavigationAudit = true
      for (const step of viewportPlan.steps) {
        await runUxViewportStep(step.id, async () => {
          const auditStart = includesNavigationAudit
            ? navigationAuditStart
            : timing.measureSync(
                'audit.checkpoint',
                step.id,
                () => pageSession.audit.checkpoint()
              )
          await timing.measure('media.reset', step.id, async () => {
            await resetUxViewportMediaMode(pageSession.page)
            await assertUxViewportMediaMode(pageSession.page, 'default', `${step.id} reset`)
          })
          await timing.measure('media.apply-and-assert', step.id, async () => {
            await applyUxViewportMediaMode(pageSession.page, step.media)
            await assertUxViewportMediaMode(pageSession.page, step.media, step.id)
          })
          await settleUxViewportPage(pageSession.page, timing, 'media', step.id)
          await assertUxCombination(pageSession, group, viewportPlan, step, timing)
          timing.measureSync(
              'audit.assert-clean',
              step.id,
              () => pageSession.audit.assertCleanSince(auditStart, step.id)
          )
          includesNavigationAudit = false
        })
      }

      await timing.measure('media.final-reset', viewportPlan.id, async () => {
        await resetUxViewportMediaMode(pageSession.page)
        await assertUxViewportMediaMode(
          pageSession.page,
          'default',
          `${viewportPlan.id} final reset`
        )
      })
      if (screenshotsEnabled) {
        await captureUxScreenshot(
          pageSession.page,
          group.route,
          viewportPlan.viewport,
          group.theme,
          timing
        )
      }
      }
    } catch (error) {
      if (failureOutputDir && !pageSession.page.isClosed()) {
        await mkdir(failureOutputDir, { recursive: true })
        await pageSession.page.screenshot({
          path: path.join(failureOutputDir, 'failure.png'),
          animations: 'disabled',
          caret: 'hide',
          fullPage: true
        }).catch(() => {})
      }
      throw error
    } finally {
      try {
        await timing.measure('media.close-reset', group.id, async () => {
          await resetUxViewportMediaMode(pageSession.page)
          await assertUxViewportMediaMode(pageSession.page, 'default', `${group.id} close reset`)
        })
      } finally {
        await timing.measure('page.close', group.id, () => pageSession.close())
      }
    }
  } finally {
    await timing.measure('context.close', group.id, () => auditedContext.close())
    timing.measureSync('context.cleanup', group.id, () => {
      if (auditedContext.context.pages().length !== 0) {
        throw new Error(`UX viewport context cleanup left pages behind for ${group.id}`)
      }
    })
  }
}

async function assertAndSeedPersistentContextIsolation(page: Page, groupId: string): Promise<void> {
  const state = await page.evaluate(async ({ marker, value }) => {
    const cookiePresent = document.cookie.split(';').some((entry) => entry.trim().startsWith(`${marker}=`))
    const cache = await caches.open(marker)
    const cachePresent = Boolean(await cache.match(`/${marker}`))
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
    const databasePresent = databases.some((database) => database.name === marker)
    const localPresent = localStorage.getItem(marker) !== null
    const sessionPresent = sessionStorage.getItem(marker) !== null

    localStorage.setItem(marker, value)
    sessionStorage.setItem(marker, value)
    document.cookie = `${marker}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`
    await cache.put(`/${marker}`, new Response(value))
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(marker, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('probe')
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })

    return { cookiePresent, cachePresent, databasePresent, localPresent, sessionPresent }
  }, {
    marker: '__fsus_ux_context_isolation__',
    value: groupId
  })
  const leaked = Object.entries(state).filter(([, present]) => present).map(([name]) => name)
  if (leaked.length > 0) {
    throw new Error(`persistent UX BrowserContext leaked ${leaked.join(', ')} into ${groupId}`)
  }
}

async function settleUxViewportPage(
  page: Page,
  timing: UxRiskTimingRecorder,
  phase: 'navigation' | 'corpus' | 'media',
  detail: string
): Promise<void> {
  if (riskMatrix) {
    const startedAt = performance.now()
    try {
      const result = await settleUxViewportRiskPage(page)
      timing.record(
        'settle.font-ready',
        `${detail}:${result.readiness.font.status}`,
        result.readiness.font.elapsedMs
      )
      for (const image of result.readiness.images) {
        timing.record(
          'settle.image-decode',
          [detail, image.status, image.completeBefore, image.naturalWidthBefore, image.url].join('|'),
          image.elapsedMs
        )
      }
    } finally {
      const elapsedMs = performance.now() - startedAt
      timing.record('settle.total', detail, elapsedMs)
      timing.record(`settle.${phase}`, detail, elapsedMs)
    }
    return
  }
  await timing.measure('settle.shared', detail, () => settlePage(page))
}

async function runUxViewportStep<T>(title: string, action: () => Promise<T>): Promise<T> {
  return persistentWorkerMode ? await action() : await test.step(title, action)
}

async function waitForUxViewportAppReady(
  page: Page,
  timing: UxRiskTimingRecorder,
  detail: string
): Promise<void> {
  if (!riskMatrix) {
    await waitForAppReady(page)
    return
  }

  const startedAt = performance.now()
  // Never keep a page.evaluate call open while issuing another Playwright
  // command for the same page. Chromium serializes those protocol operations;
  // the previous infinite in-page milestone loop therefore prevented the
  // bounded shared readiness waiter below from ever starting.
  await waitForAppReady(page, riskAppReadyTimeoutMs)
  const elapsedMs = performance.now() - startedAt
  const conditions = await page.evaluate(() => {
    const appRoot = document.querySelector('#app') as (Element & { __vue_app__?: unknown }) | null
    const isPublicShell = Boolean(document.querySelector('#fsus-aot-shell'))
    const renderableStylesheets = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      .filter((link) => {
        const href = (link.getAttribute('href') ?? '').toLowerCase()
        const marker = (link.dataset.fsusblogStyle ?? '').toLowerCase()
        return !marker.includes('font') && !href.includes('font')
      })
    return {
      documentComplete: document.readyState === 'complete',
      appRoot: Boolean(appRoot),
      vueMounted: isPublicShell || Boolean(appRoot?.__vue_app__),
      stylesReady: !isPublicShell || renderableStylesheets.length === 0
        || renderableStylesheets.some((link) => Boolean(link.sheet)),
      loaderHidden: (document.getElementById('global-loader') as HTMLElement | null)?.hidden ?? true
    }
  })
  for (const [condition, ready] of Object.entries(conditions)) {
    if (ready) timing.record(`navigation.app-ready.${condition}`, detail, elapsedMs)
  }
}

async function storageStateFor(
  browser: Browser,
  storage: StorageKind,
  testSession?: string
): Promise<StorageState | undefined> {
  if (storage === 'anonymous') {
    return undefined
  }

  if (storage === 'user') {
    const current = userStorageStates.get(browser)
      ?? captureStorageState(browser, userName, userPassword, '/user/profile', testSession)
    userStorageStates.set(browser, current)
    return await current
  }

  const current = adminStorageStates.get(browser)
    ?? captureStorageState(browser, adminName, adminPassword, '/user/manage', testSession)
  adminStorageStates.set(browser, current)
  return await current
}

async function assertUxCombination(
  session: AuditedPageSession,
  testCase: PlannedGroup,
  viewportPlan: PlannedViewport,
  step: PlannedStep,
  timing: UxRiskTimingRecorder
): Promise<void> {
  const label = `${testCase.route.id} ${viewportPlan.viewport.name} ${testCase.theme} ${step.media}`
  const expectedLocation = new URL(testCase.route.expectedUrl, session.page.url())
  await timing.measure('assert.route', step.id, async () => {
    await expect
      .poll(() => {
        const current = new URL(session.page.url())
        return testCase.route.allowQuery || testCase.route.expectedQuery
          ? current.pathname
          : `${current.pathname}${current.search}`
      }, { message: `${label} should land on expected route` })
      .toBe(testCase.route.allowQuery || testCase.route.expectedQuery
        ? expectedLocation.pathname
        : `${expectedLocation.pathname}${expectedLocation.search}`)
  })

  if (testCase.route.expectedQuery) {
    await timing.measure('assert.query', step.id, async () => {
      await expect
        .poll(() => Object.fromEntries(new URL(session.page.url()).searchParams.entries()), {
          message: `${label} should keep its canonical query state`
        })
        .toEqual(testCase.route.expectedQuery)
    })
  }

  await timing.measure(
    'assert.app-root',
    step.id,
    () => expect(session.page.locator('#app'), `${label} should render one app root`).toHaveCount(1)
  )
  await timing.measure(
    'assert.main-visible',
    step.id,
    () => expect(session.page.locator('main:visible, #app:visible').first(), `${label} should show main shell`).toBeVisible()
  )
  await timing.measure(
    'assert.document-viewport-meta',
    step.id,
    () => assertDocumentViewportMetaContract(session.page, label)
  )
  await timing.measure(
    'assert.theme-readable',
    step.id,
    () => assertThemeReadable(session.page, testCase.theme, label)
  )
  await timing.measure(
    'assert.viewport-accessibility-audit',
    step.id,
    () => assertViewportBoundaryContract(session.page, label)
  )
}

async function runUxSafeAreaGroup(
  browser: Browser,
  group: PlannedGroup,
  timing: UxRiskTimingRecorder,
  failureOutputDir?: string,
  testSession?: string
): Promise<void> {
  if (!group.profile || !group.surface) {
    throw new Error(`safe-area group ${group.id} is missing profile/surface`)
  }

  const storageState = await timing.measure(
    'fixture.storage-state',
    group.storage,
    () => storageStateFor(browser, group.storage, testSession)
  )
  const auditedContext = await timing.measure(
    'context.open',
    group.id,
    () => openThemedAuditedContext(browser, group.theme, storageState, riskMatrix || storageState !== undefined, testSession)
  )

  try {
    const pageSession = await timing.measure(
      'page.open',
      group.id,
      () => auditedContext.newPage()
    )
    try {
      const profile = group.profile
      const lightboxHarness = group.surface.open === 'article-image-lightbox'
        ? await timing.measure(
            'fixture.article-lightbox-production-surface',
            group.id,
            () => installArticleLightboxProductionSurface(pageSession.page, fixtures.articleId)
          )
        : null
      await timing.measure('safe-area.apply-profile', group.id, async () => {
        await applyUxSafeAreaProfile(pageSession.page, profile)
      })

      const navigationTarget = riskPublicBaseUrl && group.storage === 'anonymous'
        ? new URL(group.route.path, riskPublicBaseUrl).href
        : group.route.path
      await timing.measure(
        'navigation.goto',
        group.id,
        () => group.storage === 'anonymous'
          ? navigateThroughRetryablePublicAot({
              navigate: () => pageSession.page.goto(navigationTarget, { waitUntil: 'domcontentloaded' }),
              sleep: (delayMs: number) => pageSession.page.waitForTimeout(delayMs),
              deadlineAtMs: Date.now() + publicAotNavigationWindowMs
            })
          : pageSession.page.goto(navigationTarget, { waitUntil: 'domcontentloaded' })
      )
      await timing.measure(
        'navigation.app-ready',
        group.id,
        () => waitForUxViewportAppReady(pageSession.page, timing, group.id)
      )
      if (lightboxHarness) {
        await timing.measure('fixture.assert-article-lightbox-production-surface', group.id, () => (
          expect.poll(() => ({
            navigationRequests: lightboxHarness.navigationRequests(),
            productionAssetObserved: lightboxHarness.productionAssetRequests() > 0
          }), {
            message: `${group.id} should consume the compiled production lightbox surface`
          }).toEqual({
            navigationRequests: 1,
            productionAssetObserved: true
          })
        ))
      }
      await settleUxViewportPage(pageSession.page, timing, 'navigation', group.id)

      // Re-apply after navigation: SPA boots may reset inline vars on documentElement.
      await timing.measure('safe-area.reapply-profile', group.id, async () => {
        await applyUxSafeAreaProfile(pageSession.page, profile)
      })
      await timing.measure(
        'assert.document-viewport-meta',
        group.id,
        () => assertDocumentViewportMetaContract(pageSession.page, group.id)
      )

      const opened = await timing.measure(
        'safe-area.open-surface',
        group.id,
        () => openOverlayRiskSurface(pageSession.page, group.surface!.open)
      )
      if (group.surface!.open === 'article-image-lightbox') {
        await timing.measure('safe-area.settle-lightbox-motion', group.id, () => (
          settleArticleLightboxMotion(opened.scrim)
        ))
      }

      const label = group.id
      await timing.measure('safe-area.assert-scrim', label, () => (
        assertScrimCoversViewport(pageSession.page, opened.scrim, `${label} scrim`)
      ))
      await timing.measure('safe-area.assert-overflow', label, () => (
        assertNoBodyOverflowLeak(pageSession.page, label)
      ))
      await timing.measure('safe-area.assert-controls', label, () => (
        assertControlsInsideSafeRect(pageSession.page, opened.controlRoot, profile, label)
      ))
      await timing.measure('safe-area.assert-actions', label, () => (
        assertOverlayActionsReachable(pageSession.page, opened.actions, {
          label: `${label} actions`,
          shortVisual: profile.id === 'short-visual'
        })
      ))
      if (group.surface!.open === 'article-image-lightbox') {
        await timing.measure('safe-area.assert-lightbox-media', label, () => (
          assertLightboxMediaGeometry(pageSession.page, opened.controlRoot, profile, label)
        ))
        if (screenshotsEnabled) {
          await captureArticleLightboxRenderedEvidence(
            opened.scrim,
            profile,
            group.browser ?? 'unknown',
            timing
          )
        }

        if (profile.id === 'portrait-notch') {
          const landscapeProfile = UX_VIEWPORT_MATRIX.safeArea?.profiles?.['landscape-notch']
          if (!landscapeProfile) {
            throw new Error('landscape-notch safe-area profile is missing')
          }
          await timing.measure('safe-area.resize-open-lightbox', label, async () => {
            await applyUxSafeAreaProfile(pageSession.page, landscapeProfile)
            await pageSession.page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
          })
          await timing.measure('safe-area.assert-resized-scrim', label, () => (
            assertScrimCoversViewport(pageSession.page, opened.scrim, `${label} resized scrim`)
          ))
          await timing.measure('safe-area.assert-resized-controls', label, () => (
            assertControlsInsideSafeRect(pageSession.page, opened.controlRoot, landscapeProfile, `${label} resized`)
          ))
          await timing.measure('safe-area.assert-resized-actions', label, () => (
            assertOverlayActionsReachable(pageSession.page, opened.actions, { label: `${label} resized actions` })
          ))
          await timing.measure('safe-area.assert-resized-media', label, () => (
            assertLightboxMediaGeometry(pageSession.page, opened.controlRoot, landscapeProfile, `${label} resized`)
          ))
          await timing.measure('safe-area.restore-open-lightbox', label, async () => {
            await applyUxSafeAreaProfile(pageSession.page, profile)
            await pageSession.page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
          })
        }
      }

      await timing.measure('safe-area.close-surface', label, () => closeOverlayRiskSurface(pageSession.page, group.surface!.open))
      await timing.measure('safe-area.assert-restore', label, () => (
        assertOverlayCloseRestoresFocusAndScroll(pageSession.page, {
          label,
          expectedScrollY: opened.scrollYAtOpen,
          trigger: opened.trigger
        })
      ))

      if (group.surface!.open === 'article-image-lightbox') {
        const reopened = await timing.measure(
          'safe-area.reopen-lightbox',
          label,
          () => openOverlayRiskSurface(pageSession.page, group.surface!.open)
        )
        await timing.measure('safe-area.settle-reopened-lightbox-motion', label, () => (
          settleArticleLightboxMotion(reopened.scrim)
        ))
        await timing.measure('safe-area.assert-reopened-scrim', label, () => (
          assertScrimCoversViewport(pageSession.page, reopened.scrim, `${label} reopened scrim`)
        ))
        await timing.measure('safe-area.assert-reopened-controls', label, () => (
          assertControlsInsideSafeRect(pageSession.page, reopened.controlRoot, profile, `${label} reopened`)
        ))
        await timing.measure('safe-area.assert-reopened-media', label, () => (
          assertLightboxMediaGeometry(pageSession.page, reopened.controlRoot, profile, `${label} reopened`)
        ))
        await timing.measure(
          'safe-area.reclose-lightbox',
          label,
          () => closeOverlayRiskSurface(pageSession.page, group.surface!.open)
        )
        await timing.measure('safe-area.assert-rerestore', label, () => (
          assertOverlayCloseRestoresFocusAndScroll(pageSession.page, {
            label: `${label} reopened`,
            expectedScrollY: reopened.scrollYAtOpen,
            trigger: reopened.trigger
          })
        ))
      }

      await timing.measure('safe-area.clear-profile', group.id, () => clearUxSafeAreaProfileOverrides(pageSession.page))
    } catch (error) {
      if (failureOutputDir && !pageSession.page.isClosed()) {
        await mkdir(failureOutputDir, { recursive: true })
        await pageSession.page.screenshot({
          path: path.join(failureOutputDir, 'failure.png'),
          animations: 'disabled',
          caret: 'hide',
          fullPage: true
        }).catch(() => {})
      }
      throw error
    } finally {
      await timing.measure('page.close', group.id, () => pageSession.close())
    }
  } finally {
    await timing.measure('context.close', group.id, () => auditedContext.close())
  }
}

async function settleArticleLightboxMotion(scrim: Locator): Promise<void> {
  await scrim.evaluate(async (element) => {
    await Promise.allSettled(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished)
    )
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
}

async function captureArticleLightboxRenderedEvidence(
  scrim: Locator,
  profile: UxSafeAreaProfile,
  browser: string,
  timing: UxRiskTimingRecorder
): Promise<void> {
  const detail = `article-lightbox:${profile.id}:${browser}`
  const file = path.join(
    screenshotRoot,
    'safe-area',
    profile.id,
    browser,
    'article-lightbox.png'
  )
  await timing.measure('screenshot.mkdir', detail, () => mkdir(path.dirname(file), { recursive: true }))
  await timing.measure('screenshot.capture', detail, () => scrim.screenshot({
    path: file,
    animations: 'disabled',
    caret: 'hide'
  }))
}

type OpenedOverlay = Readonly<{
  scrim: Locator
  controlRoot: Locator
  actions: Locator[]
  trigger: Locator | null
  scrollYAtOpen: number
}>

function visible(locator: Locator): Locator {
  return locator.filter({ visible: true })
}

async function openOverlayRiskSurface(page: import('@playwright/test').Page, open: string): Promise<OpenedOverlay> {
  switch (open) {
    case 'policy-modal': {
      const trigger = page.locator('.register-guidelines-button, button:has-text("社区规范"), a:has-text("社区规范")').first()
      await expect(trigger, 'policy modal trigger').toBeVisible()
      await trigger.scrollIntoViewIfNeeded()
      const scrollYAtOpen = await page.evaluate(() => window.scrollY)
      await trigger.click()
      const dialog = visible(page.locator('.el-dialog, [role="dialog"]')).last()
      await expect(dialog).toBeVisible()
      const scrim = visible(page.locator('.el-overlay').filter({ has: page.locator('.el-dialog') })).last()
      return {
        scrim,
        controlRoot: dialog,
        actions: [
          visible(page.locator('.el-dialog__headerbtn, .el-dialog [aria-label="Close"], .el-dialog button').filter({ hasNot: page.locator('[disabled]') })).first(),
          visible(page.locator('.el-dialog__footer button, .el-dialog button').last())
        ],
        trigger,
        scrollYAtOpen
      }
    }
    case 'settings-refresh-cache': {
      // MessageBox via admin settings "强制刷新缓存".
      const pagesTab = page.locator('.el-tabs__item').filter({ hasText: /页面|Pages|page/i }).first()
      if (await pagesTab.count()) {
        await pagesTab.click().catch(() => undefined)
      }
      const trigger = page.getByRole('button', { name: /强制刷新缓存|刷新缓存|强制刷新/ }).first()
      await expect(trigger, 'settings refresh-cache trigger').toBeVisible({ timeout: 20_000 })
      await trigger.scrollIntoViewIfNeeded()
      const scrollYAtOpen = await page.evaluate(() => window.scrollY)
      await trigger.click()
      const box = visible(page.locator('.el-message-box')).last()
      await expect(box).toBeVisible()
      const scrim = visible(page.locator('.el-overlay.is-message-box')).last()
      return {
        scrim,
        controlRoot: box,
        actions: [
          visible(page.locator('.el-message-box__headerbtn')).last(),
          visible(page.locator('.el-message-box__btns button')).nth(0),
          visible(page.locator('.el-message-box__btns button')).nth(1)
        ],
        trigger,
        scrollYAtOpen
      }
    }
    case 'article-image-lightbox': {
      await ensureArticleBodyImage(page)
      const trigger = page.locator('img.fsus-article-preview-image, img[data-fsus-motion-surface="article-body-image"]').first()
      await expect(trigger, 'article body image trigger').toBeVisible({ timeout: 20_000 })
      await trigger.scrollIntoViewIfNeeded()
      const scrollYAtOpen = await page.evaluate(() => window.scrollY)
      await trigger.click()
      const root = visible(page.locator('[data-article-lightbox="true"]')).last()
      await expect(root).toBeVisible()
      const scrim = root
      const actions = [
        root.getByRole('button', { name: '关闭大图', exact: true })
      ]
      const prev = root.getByRole('button', { name: '上一张', exact: true })
      const next = root.getByRole('button', { name: '下一张', exact: true })
      if (await prev.count()) actions.push(visible(prev).last())
      if (await next.count()) actions.push(visible(next).last())
      return {
        scrim,
        controlRoot: root,
        actions,
        trigger,
        scrollYAtOpen
      }
    }
    case 'account-mobile-drawer': {
      const trigger = page.locator('.account-mobile-drawer-trigger').first()
      await expect(trigger, 'account mobile drawer trigger').toBeVisible()
      await trigger.scrollIntoViewIfNeeded()
      const scrollYAtOpen = await page.evaluate(() => window.scrollY)
      await trigger.click()
      const drawer = visible(page.locator('#account-mobile-drawer, .account-mobile-drawer, .el-drawer')).last()
      await expect(drawer).toBeVisible()
      const scrim = visible(page.locator('.el-overlay').filter({ has: page.locator('.el-drawer, #account-mobile-drawer') })).last()
      return {
        scrim,
        controlRoot: drawer,
        actions: [
          visible(page.locator('.el-drawer__close-btn, .el-drawer [aria-label="Close"]')).last()
        ],
        trigger,
        scrollYAtOpen
      }
    }
    default:
      throw new Error(`unknown overlay-risk open strategy: ${open}`)
  }
}

async function closeOverlayRiskSurface(page: import('@playwright/test').Page, open: string): Promise<void> {
  if (open === 'settings-refresh-cache') {
    const cancel = page.locator('.el-message-box__btns button').first()
    if (await cancel.count()) {
      await cancel.click({ force: true }).catch(() => undefined)
    }
  } else if (open === 'article-image-lightbox') {
    const close = page.getByRole('dialog').getByRole('button', { name: '关闭大图', exact: true })
    if (await close.count()) {
      await close.click({ force: true }).catch(() => undefined)
    }
  } else if (open === 'account-mobile-drawer') {
    const close = page.locator('.el-drawer__close-btn')
    if (await close.count()) {
      await close.click({ force: true }).catch(() => undefined)
    }
  } else {
    const footerClose = page.locator('.el-dialog__footer button, .el-dialog__headerbtn').last()
    if (await footerClose.count()) {
      await footerClose.click({ force: true }).catch(() => undefined)
    }
  }

  await page.keyboard.press('Escape').catch(() => undefined)
  await page.waitForFunction(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(
      'body > .el-overlay, .el-overlay.is-message-box, [data-article-lightbox="true"]'
    ))
    return nodes.every((element) => {
      const style = getComputedStyle(element)
      return style.display === 'none'
        || style.visibility === 'hidden'
        || Number(style.opacity) === 0
        || element.getBoundingClientRect().width <= 0
    })
  }, undefined, { timeout: 5_000 }).catch(() => undefined)
}

async function ensureArticleBodyImage(page: import('@playwright/test').Page): Promise<void> {
  const existing = page.locator(
    'img.fsus-article-preview-image[data-fsus-motion-surface="article-body-image"]'
  )
  await expect(existing.first(), 'production article body image fixture').toBeVisible({ timeout: 20_000 })
}

async function injectContentBoundaryCorpus(page: Page): Promise<void> {
  await page.evaluate((corpus) => {
    const host = document.querySelector('main') ?? document.body
    document.querySelector('[data-ux-content-boundary-corpus]')?.remove()

    const section = document.createElement('section')
    section.dataset.uxContentBoundaryCorpus = corpus.version
    section.className = 'markdown-body prose fsus-ux-boundary-probe'
    section.style.maxWidth = '760px'
    section.style.width = '100%'
    section.setAttribute('aria-label', 'UX content boundary corpus')

    const title = document.createElement('h2')
    title.textContent = 'UX content boundary corpus'
    section.appendChild(title)

    for (const item of corpus.cases) {
      const block = document.createElement('article')
      block.dataset.uxBoundaryCase = item.id
      block.dataset.uxBoundaryKind = item.kind

      if (item.kind === 'code') {
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        code.textContent = item.sample
        pre.appendChild(code)
        block.appendChild(pre)
      } else if (item.kind === 'katex') {
        const formula = document.createElement('div')
        formula.className = 'katex-display'
        formula.textContent = item.sample
        block.appendChild(formula)
      } else if (item.kind === 'mermaid') {
        const graph = document.createElement('pre')
        graph.className = 'mermaid'
        graph.textContent = item.sample
        block.appendChild(graph)
      } else if (item.kind === 'image') {
        const image = document.createElement('img')
        image.src = item.sample
        image.alt = item.id
        image.loading = 'lazy'
        image.decoding = 'async'
        block.appendChild(image)
      } else {
        const paragraph = document.createElement(item.kind === 'title' ? 'h3' : 'p')
        paragraph.textContent = item.sample
        block.appendChild(paragraph)
      }

      section.appendChild(block)
    }

    host.appendChild(section)
  }, UX_CONTENT_BOUNDARY_CORPUS)
}

async function captureUxScreenshot(
  page: Page,
  route: UxRoute,
  viewport: UxViewport,
  theme: ThemeMode,
  timing: UxRiskTimingRecorder
): Promise<void> {
  const detail = `${route.id}:${theme}:${viewport.name}`
  await timing.measure('screenshot.freeze', detail, () => freezeUiForScreenshot(page))
  const target = page.locator(route.screenshotSelector).first()
  await timing.measure(
    'screenshot.target-visible',
    detail,
    () => expect(target, `${route.id} screenshot target`).toBeVisible()
  )
  const file = path.join(
    screenshotRoot,
    viewport.name,
    theme,
    `${sanitizeFilename(route.id)}.png`
  )
  await timing.measure('screenshot.mkdir', detail, () => mkdir(path.dirname(file), { recursive: true }))
  await timing.measure('screenshot.capture', detail, () => target.screenshot({
      path: file,
      animations: 'disabled',
      caret: 'hide'
    }))
}

function createUxRiskTimingRecorder(group: PlannedGroup, enabled: boolean) {
  const startedAt = performance.now()
  const buckets = new Map<string, {
    calls: number
    totalMs: number
    maxMs: number
    maxDetail: string
  }>()
  const record = (phase: string, detail: string, elapsedMs: number) => {
    if (!enabled) return
    const current = buckets.get(phase) ?? { calls: 0, totalMs: 0, maxMs: 0, maxDetail: '' }
    current.calls += 1
    current.totalMs += elapsedMs
    if (elapsedMs > current.maxMs) {
      current.maxMs = elapsedMs
      current.maxDetail = detail
    }
    buckets.set(phase, current)
  }
  const measure = async <T>(phase: string, detail: string, action: () => Promise<T>): Promise<T> => {
    if (!enabled) return await action()
    const phaseStartedAt = performance.now()
    try {
      return await action()
    } finally {
      record(phase, detail, performance.now() - phaseStartedAt)
    }
  }
  const measureSync = <T>(phase: string, detail: string, action: () => T): T => {
    if (!enabled) return action()
    const phaseStartedAt = performance.now()
    try {
      return action()
    } finally {
      record(phase, detail, performance.now() - phaseStartedAt)
    }
  }
  const summary = (error: unknown) => ({
    schema: 'fsusblog.ux-viewport-risk-timing.v1',
    status: error === null ? 'passed' : 'failed',
    groupId: group.id,
    routeId: group.route.id,
    theme: group.theme,
    navigationCount: group.viewports.length,
    caseCount: group.viewports.reduce((total, viewport) => total + viewport.steps.length, 0),
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    phases: Object.fromEntries([...buckets.entries()].map(([phase, bucket]) => [phase, {
      calls: bucket.calls,
      totalMs: Math.round(bucket.totalMs * 100) / 100,
      averageMs: Math.round(bucket.totalMs / bucket.calls * 100) / 100,
      maxMs: Math.round(bucket.maxMs * 100) / 100,
      maxDetail: bucket.maxDetail
    }])),
    semantics: {
      axeCalls: 0,
      axeReason: 'viewport-boundaries.spec.ts has no axe invocation',
      runtimeAudit: 'assertCleanSince executes once per case',
      accessibilityAudit: 'theme readability, focus outline, sticky focus, and viewport boundary checks execute once per case'
    },
    error: error instanceof Error ? error.message : error === null ? null : String(error)
  })
  return { enabled, measure, measureSync, record, summary }
}

async function publishUxRiskTiming(
  timing: UxRiskTimingRecorder,
  testInfo: TestInfo,
  error: unknown
): Promise<void> {
  if (!timing.enabled) return
  const summary = timing.summary(error)
  console.log(`[ux-risk-timing] ${JSON.stringify(summary)}`)
  await testInfo.attach('ux-risk-timing', {
    body: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`),
    contentType: 'application/json'
  })
}

function currentTestArtifacts(testInfo: TestInfo): string[] {
  return testInfo.attachments
    .map((attachment) => attachment.path)
    .filter((file): file is string => Boolean(file))
    .map((file) => path.relative(repositoryRoot, file).replaceAll(path.sep, '/'))
}

function sanitizeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'route'
}
