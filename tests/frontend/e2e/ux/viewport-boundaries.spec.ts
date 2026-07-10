import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Browser, Page, StorageState, TestInfo } from '@playwright/test'
import {
  UX_CONTENT_BOUNDARY_CORPUS,
  UX_VIEWPORT_MATRIX,
  type AuditedPageSession,
  type ThemeMode,
  type UxViewport,
  type UxViewportMediaMode,
  type UxViewportMode,
  adminName,
  adminPassword,
  applyUxViewportMediaMode,
  assertThemeReadable,
  assertUxViewportMediaMode,
  assertViewportBoundaryContract,
  captureStorageState,
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
import { buildUxViewportPlan } from '../../support/playwright/uxViewportPlan.mjs'
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
  route: UxRoute
  theme: ThemeMode
  storage: StorageKind
  viewports: PlannedViewport[]
}>

type UxPlan = Readonly<{
  mode: UxViewportMode
  fingerprint: string
  groups: PlannedGroup[]
  counts: Readonly<{
    routes: number
    routeThemeGroups: number
    navigations: number
    cases: number
  }>
}>

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const mode = parseMode(process.env.FSUSBLOG_UX_VIEWPORT_MODE)
const modeConfig = UX_VIEWPORT_MATRIX.modes[mode]
const screenshotsEnabled = modeConfig.screenshots === true
  || readBooleanFlag('FSUSBLOG_UX_VIEWPORT_SCREENSHOTS')
const usesIsolatedSessions = process.env.FSUSBLOG_TEST_SESSION_ISOLATION === '1'
const viewportExecutionMode = mode === 'smoke' || usesIsolatedSessions
  ? 'parallel'
  : 'default'
const resume = readBooleanFlag('FSUSBLOG_UX_VIEWPORT_RESUME')
const plan = buildUxViewportPlan({
  matrix: UX_VIEWPORT_MATRIX,
  routes: buildUxRoutes(),
  mode,
  filters: {
    routeIds: readOptionalList('FSUSBLOG_UX_VIEWPORT_ROUTE_IDS'),
    themes: readOptionalList('FSUSBLOG_UX_VIEWPORT_THEMES'),
    viewportIds: readOptionalList('FSUSBLOG_UX_VIEWPORT_VIEWPORTS'),
    media: readOptionalList('FSUSBLOG_UX_VIEWPORT_MEDIA')
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

let userStorageStatePromise: Promise<StorageState> | null = null
let adminStorageStatePromise: Promise<StorageState> | null = null

test.describe(`UX viewport boundaries (${mode})`, () => {
  test.describe.configure({
    mode: viewportExecutionMode,
    timeout: mode === 'boundaries' ? 1_200_000 : 300_000
  })

  for (const group of plan.groups) {
    test(group.id, async ({ browser }, testInfo) => {
      test.skip(
        resume && progressRun.completedGroupIds.has(group.id),
        `completed by UX viewport run ${progressRun.progress.runId}`
      )

      try {
        await runUxRouteThemeGroup(browser, group)
      } catch (error) {
        await recordUxViewportGroupResult({
          run: progressRun,
          plan,
          groupId: group.id,
          status: 'failed',
          error,
          artifacts: currentTestArtifacts(testInfo)
        })
        throw error
      }

      await recordUxViewportGroupResult({
        run: progressRun,
        plan,
        groupId: group.id,
        status: 'passed',
        artifacts: currentTestArtifacts(testInfo)
      })
    })
  }
})

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

async function runUxRouteThemeGroup(browser: Browser, group: PlannedGroup): Promise<void> {
  const storageState = await storageStateFor(browser, group.storage)
  const auditedContext = await openThemedAuditedContext(browser, group.theme, storageState)

  try {
    for (const viewportPlan of group.viewports) {
      const pageSession = await auditedContext.newPage()
      try {
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

        const navigationAuditStart = pageSession.audit.checkpoint()
        await pageSession.page.goto(group.route.path, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(pageSession.page)
        await settlePage(pageSession.page)
        if (group.route.injectCorpus) {
          await injectContentBoundaryCorpus(pageSession.page)
          await settlePage(pageSession.page)
        }

        let includesNavigationAudit = true
        for (const step of viewportPlan.steps) {
          await test.step(step.id, async () => {
            const auditStart = includesNavigationAudit
              ? navigationAuditStart
              : pageSession.audit.checkpoint()
            await resetUxViewportMediaMode(pageSession.page)
            await assertUxViewportMediaMode(pageSession.page, 'default', `${step.id} reset`)
            await applyUxViewportMediaMode(pageSession.page, step.media)
            await assertUxViewportMediaMode(pageSession.page, step.media, step.id)
            await settlePage(pageSession.page)
            await assertUxCombination(pageSession, group, viewportPlan, step)
            pageSession.audit.assertCleanSince(auditStart, step.id)
            includesNavigationAudit = false
          })
        }

        await resetUxViewportMediaMode(pageSession.page)
        await assertUxViewportMediaMode(
          pageSession.page,
          'default',
          `${viewportPlan.id} final reset`
        )
        if (screenshotsEnabled) {
          await captureUxScreenshot(
            pageSession.page,
            group.route,
            viewportPlan.viewport,
            group.theme
          )
        }
      } finally {
        try {
          await resetUxViewportMediaMode(pageSession.page)
          await assertUxViewportMediaMode(
            pageSession.page,
            'default',
            `${viewportPlan.id} close reset`
          )
        } finally {
          await pageSession.close()
        }
      }
    }
  } finally {
    await auditedContext.close()
  }
}

async function storageStateFor(browser: Browser, storage: StorageKind): Promise<StorageState | undefined> {
  if (storage === 'anonymous') {
    return undefined
  }

  if (storage === 'user') {
    userStorageStatePromise ??= captureStorageState(browser, userName, userPassword, '/user/profile')
    return await userStorageStatePromise
  }

  adminStorageStatePromise ??= captureStorageState(browser, adminName, adminPassword, '/user/manage')
  return await adminStorageStatePromise
}

async function assertUxCombination(
  session: AuditedPageSession,
  testCase: PlannedGroup,
  viewportPlan: PlannedViewport,
  step: PlannedStep
): Promise<void> {
  const label = `${testCase.route.id} ${viewportPlan.viewport.name} ${testCase.theme} ${step.media}`
  const expectedLocation = new URL(testCase.route.expectedUrl, session.page.url())
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

  if (testCase.route.expectedQuery) {
    await expect
      .poll(() => Object.fromEntries(new URL(session.page.url()).searchParams.entries()), {
        message: `${label} should keep its canonical query state`
      })
      .toEqual(testCase.route.expectedQuery)
  }

  await expect(session.page.locator('#app'), `${label} should render one app root`).toHaveCount(1)
  await expect(session.page.locator('main, #app').first(), `${label} should show main shell`).toBeVisible()
  await assertThemeReadable(session.page, testCase.theme, label)
  await assertViewportBoundaryContract(session.page, label)
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
  theme: ThemeMode
): Promise<void> {
  await freezeUiForScreenshot(page)
  const target = page.locator(route.screenshotSelector).first()
  await expect(target, `${route.id} screenshot target`).toBeVisible()
  const file = path.join(
    screenshotRoot,
    viewport.name,
    theme,
    `${sanitizeFilename(route.id)}.png`
  )
  await mkdir(path.dirname(file), { recursive: true })
  await target.screenshot({
    path: file,
    animations: 'disabled',
    caret: 'hide'
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
