import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Browser, Page, StorageState } from '@playwright/test'
import {
  UX_CONTENT_BOUNDARY_CORPUS,
  UX_VIEWPORT_MATRIX,
  type ThemeMode,
  type UxViewport,
  type UxViewportMode,
  adminName,
  adminPassword,
  assertThemeReadable,
  assertViewportBoundaryContract,
  captureStorageState,
  fixtures,
  freezeUiForScreenshot,
  openThemedAuditedPage,
  settlePage,
  userName,
  userPassword,
  uxViewportsForMode,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import {
  buildAdminRoutes,
  buildAnonymousRoutes,
  buildUserRoutes
} from '../../support/playwright/routeAuditMatrix'

type StorageKind = 'anonymous' | 'user' | 'admin'
type MediaMode = 'default' | 'zoom-125' | 'zoom-150' | 'zoom-200' | 'large-text' | 'reduced-motion' | 'high-contrast'

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

type UxCase = Readonly<{
  viewport: UxViewport
  route: UxRoute
  theme: ThemeMode
  media: MediaMode
}>

type UxCaseGroup = Readonly<{
  id: string
  viewport: UxViewport
  theme: ThemeMode
  media: MediaMode
  storage: StorageKind
  cases: UxCase[]
}>

const mode = parseMode(process.env.FSUSBLOG_UX_VIEWPORT_MODE)
const modeConfig = UX_VIEWPORT_MATRIX.modes[mode]
const themes = modeConfig.themes as ThemeMode[]
const mediaModes = modeConfig.media as MediaMode[]
const themeIds = readOptionalSet('FSUSBLOG_UX_VIEWPORT_THEMES')
const mediaIds = readOptionalSet('FSUSBLOG_UX_VIEWPORT_MEDIA')
const viewportIds = readOptionalSet('FSUSBLOG_UX_VIEWPORT_VIEWPORTS')
const routeIds = readOptionalSet('FSUSBLOG_UX_VIEWPORT_ROUTE_IDS')
  ?? (modeConfig.routes === 'all' ? null : new Set(modeConfig.routes))
const selectedThemes = themeIds ? themes.filter((theme) => themeIds.has(theme)) : themes
const selectedMediaModes = mediaIds ? mediaModes.filter((media) => mediaIds.has(media)) : mediaModes
const selectedViewports = viewportIds
  ? uxViewportsForMode(mode).filter((viewport) => viewportIds.has(viewport.name))
  : uxViewportsForMode(mode)
const screenshotsEnabled = modeConfig.screenshots === true || process.env.FSUSBLOG_UX_VIEWPORT_SCREENSHOTS === '1'
const usesIsolatedSessions = process.env.FSUSBLOG_TEST_SESSION_ISOLATION === '1'
const viewportExecutionMode = mode === 'smoke' || usesIsolatedSessions
  ? 'parallel'
  : 'default'
const outputRoot = path.resolve(process.cwd(), '../../.tmp/ux')
const screenshotRoot = path.join(outputRoot, 'screenshots', mode)

let userStorageStatePromise: Promise<StorageState> | null = null
let adminStorageStatePromise: Promise<StorageState> | null = null

test.describe(`UX viewport boundaries (${mode})`, () => {
  test.describe.configure({
    mode: viewportExecutionMode,
    timeout: mode === 'boundaries' ? 1_200_000 : 300_000
  })

  const routes = buildUxRoutes().filter((route) => routeIds === null || routeIds.has(route.id))
  const cases = buildCases(selectedViewports, routes, selectedThemes, selectedMediaModes)

  if (routes.length === 0 || cases.length === 0) {
    throw new Error(`${mode} viewport matrix should not be empty`)
  }

  for (const caseGroup of buildCaseGroups(cases)) {
    test(`${caseGroup.id} keeps viewport boundaries usable`, async ({ browser }) => {
      await runUxCaseGroup(browser, caseGroup)
    })
  }
})

function buildCaseGroups(cases: UxCase[]): UxCaseGroup[] {
  const groups = new Map<string, UxCaseGroup>()

  for (const testCase of cases) {
    const key = [testCase.viewport.name, testCase.theme, testCase.media, testCase.route.storage].join('|')
    let group = groups.get(key)
    if (!group) {
      const groupNumber = String(groups.size + 1).padStart(3, '0')
      group = {
        id: `group-${groupNumber}-${testCase.viewport.name}-${testCase.theme}-${testCase.media}-${testCase.route.storage}`,
        viewport: testCase.viewport,
        theme: testCase.theme,
        media: testCase.media,
        storage: testCase.route.storage,
        cases: []
      }
      groups.set(key, group)
    }
    group.cases.push(testCase)
  }

  return [...groups.values()]
}

function parseMode(value: string | undefined): UxViewportMode {
  if (value === 'visual' || value === 'boundaries') {
    return value
  }
  return 'smoke'
}

function readOptionalSet(name: string): Set<string> | null {
  const raw = process.env[name]
  if (!raw) {
    return null
  }

  const values = raw.split(',').map((value) => value.trim()).filter(Boolean)
  return values.length > 0 ? new Set(values) : null
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

function buildCases(
  viewports: UxViewport[],
  routes: UxRoute[],
  selectedThemes: ThemeMode[],
  selectedMediaModes: MediaMode[]
): UxCase[] {
  const cases: UxCase[] = []

  for (const viewport of viewports) {
    for (const theme of selectedThemes) {
      for (const route of routes) {
        cases.push({ viewport, route, theme, media: 'default' as const })

        for (const media of extraMediaModesForRoute(route, selectedMediaModes)) {
          cases.push({ viewport, route, theme, media })
        }
      }
    }
  }

  return cases
}

function extraMediaModesForRoute(route: UxRoute, selectedMediaModes: MediaMode[]): MediaMode[] {
  const nonDefault = selectedMediaModes.filter((candidate) => candidate !== 'default')
  const shouldProbeMedia = mode === 'boundaries'
    || ['public-article', 'public-login', 'user-profile', 'user-messagebox', 'manage-write', 'manage-users'].includes(route.id)
  if (shouldProbeMedia) {
    return nonDefault
  }

  return []
}

async function runUxCaseGroup(browser: Browser, group: UxCaseGroup): Promise<void> {
  const storageState = await storageStateFor(browser, group.storage)
  const session = await openThemedAuditedPage(browser, group.theme, storageState)

  try {
    await session.page.setViewportSize({ width: group.viewport.width, height: group.viewport.height })
    await applyMediaMode(session.page, group.media)
    for (const testCase of group.cases) {
      await runUxCase(session, testCase)
    }
  } finally {
    await session.close()
  }
}

async function runUxCase(
  session: Awaited<ReturnType<typeof openThemedAuditedPage>>,
  testCase: UxCase
): Promise<void> {
  const label = `${testCase.route.id} ${testCase.viewport.name} ${testCase.theme} ${testCase.media}`

  await applyMediaMode(session.page, testCase.media)
  const start = session.audit.checkpoint()
  await session.page.goto(testCase.route.path, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(session.page)
  await applyMediaMode(session.page, testCase.media)
  await settlePage(session.page)

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

  if (testCase.route.injectCorpus) {
    await injectContentBoundaryCorpus(session.page)
    await settlePage(session.page)
  }

  await expect(session.page.locator('#app'), `${label} should render one app root`).toHaveCount(1)
  await expect(session.page.locator('main, #app').first(), `${label} should show main shell`).toBeVisible()
  await assertThemeReadable(session.page, testCase.theme, label)
  await assertViewportBoundaryContract(session.page, label)

  if (screenshotsEnabled && testCase.media === 'default') {
    await captureUxScreenshot(session.page, testCase.route, testCase.viewport, testCase.theme)
  }

  session.audit.assertCleanSince(start, label)
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

async function applyMediaMode(page: Page, media: MediaMode): Promise<void> {
  if (media === 'reduced-motion') {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  } else if (media === 'high-contrast') {
    await page.emulateMedia({ contrast: 'more', forcedColors: 'active' } as Parameters<Page['emulateMedia']>[0])
  }

  if (media === 'large-text') {
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' })
  } else if (media === 'zoom-125') {
    await page.addStyleTag({ content: 'html { zoom: 1.25; }' })
  } else if (media === 'zoom-150') {
    await page.addStyleTag({ content: 'html { zoom: 1.5; }' })
  } else if (media === 'zoom-200') {
    await page.addStyleTag({ content: 'html { zoom: 2; }' })
  }
}

async function injectContentBoundaryCorpus(page: Page): Promise<void> {
  await page.evaluate((corpus) => {
    const host = document.querySelector('main') ?? document.body
    const existing = document.querySelector('[data-ux-content-boundary-corpus]')
    existing?.remove()

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

async function captureUxScreenshot(page: Page, route: UxRoute, viewport: UxViewport, theme: ThemeMode): Promise<void> {
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

function sanitizeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'route'
}
