import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Browser, type Page, type StorageState } from '@playwright/test'
import {
  buildAdminRoutes,
  buildAnonymousRoutes,
  buildUserRoutes,
  type RouteCheck
} from '../../support/playwright/routeAuditMatrix'
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  NARROW_MOBILE_VIEWPORT,
  type ThemeMode,
  adminName,
  adminPassword,
  assertResponsiveLayoutContract,
  captureStorageState,
  freezeUiForScreenshot,
  openThemedAuditedPage,
  settlePage,
  userName,
  userPassword,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import { loadAuditFixtures } from '../../support/playwright/routeAuditFixtures'

type ManualRoute = RouteCheck & {
  scope: 'anonymous' | 'user' | 'admin' | 'edge'
  allowExpectedRuntimeNoise?: boolean
}

type ManualViewport = Readonly<{
  name: string
  size: typeof DESKTOP_VIEWPORT
  routeFilter?: (route: ManualRoute) => boolean
}>

const fixtures = loadAuditFixtures()
const themes: ThemeMode[] = ['light', 'dark']

const viewports: ManualViewport[] = [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT },
  {
    name: 'narrow-mobile',
    size: NARROW_MOBILE_VIEWPORT,
    routeFilter: (route) => route.scope === 'edge'
  }
]

const extremeSearchPath = `/search?q=${encodeURIComponent(
  'markdown latex mermaid <script><script><script> very-long-query-for-layout-boundary 边界 搜索 FsusUI 1.4.1'
)}&sort=recent`

const routeSets: Array<{
  scope: ManualRoute['scope']
  storage: 'anonymous' | 'user' | 'admin'
  routes: ManualRoute[]
}> = [
  {
    scope: 'anonymous',
    storage: 'anonymous',
    routes: buildAnonymousRoutes(fixtures).map((route) => ({ ...route, scope: 'anonymous' }))
  },
  {
    scope: 'user',
    storage: 'user',
    routes: buildUserRoutes().map((route) => ({ ...route, scope: 'user' }))
  },
  {
    scope: 'admin',
    storage: 'admin',
    routes: buildAdminRoutes(fixtures).map((route) => ({ ...route, scope: 'admin' }))
  },
  {
    scope: 'edge',
    storage: 'anonymous',
    routes: [
      { name: 'edge-search-extreme', path: extremeSearchPath, expectedUrl: extremeSearchPath, scope: 'edge' },
      {
        name: 'edge-article-missing',
        path: '/article/99999999',
        expectedUrl: '/article/99999999',
        scope: 'edge',
        allowExpectedRuntimeNoise: true
      },
      { name: 'edge-tag-slug', path: '/tag/fsus-ui-1-4-0-edge', expectedUrl: '/tag/fsus-ui-1-4-0-edge', scope: 'edge' },
      { name: 'edge-login-long-redirect', path: `/login?redirect=${encodeURIComponent('/user/manage/article/write?draft=edge-long-title')}`, expectedUrl: `/login?redirect=${encodeURIComponent('/user/manage/article/write?draft=edge-long-title')}`, scope: 'edge' },
      { name: 'edge-not-found-deep', path: '/route/that/does/not/exist/with/a/very/long/path/segment', expectedUrl: '/route/that/does/not/exist/with/a/very/long/path/segment', scope: 'edge' }
    ]
  }
]

const screenshotRoot = path.resolve(
  process.env.FSUSBLOG_MANUAL_SCREENSHOT_DIR
    ?? path.resolve(process.cwd(), '../../.tmp/manual-layout-screenshots/current')
)

function screenshotPath(route: ManualRoute, viewport: ManualViewport, theme: ThemeMode): string {
  return path.join(
    screenshotRoot,
    viewport.name,
    theme,
    route.scope,
    `${sanitizeFilename(route.name)}.png`
  )
}

function sanitizeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'route'
}

async function captureRouteScreenshot(page: Page, route: ManualRoute, viewport: ManualViewport, theme: ThemeMode): Promise<void> {
  await page.setViewportSize(viewport.size)
  await page.goto(route.path, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
  await settlePage(page)

  await expect
    .poll(() => {
      const current = new URL(page.url())
      return `${current.pathname}${current.search}`
    }, { message: `${route.name} should land on expected route before manual screenshot capture` })
    .toBe(route.expectedUrl)

  await expect(page.locator('#app'), `${route.name} should render one app root`).toHaveCount(1)
  await assertManualThemeReadable(page, theme, route.name)
  await assertResponsiveLayoutContract(page, `${route.name} ${viewport.name} ${theme}`)
  await freezeUiForScreenshot(page)

  const outputPath = screenshotPath(route, viewport, theme)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide'
  })
}

async function assertManualThemeReadable(page: Page, mode: ThemeMode, label: string): Promise<void> {
  const palette = await page.evaluate(() => {
    const root = document.documentElement
    const read = (selector: string) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) {
        return null
      }

      const style = getComputedStyle(element)
      return {
        color: style.color,
        backgroundColor: style.backgroundColor
      }
    }

    return {
      themeMode: root.dataset.themeMode ?? '',
      themeResolved: root.dataset.themeResolved ?? '',
      hasDarkClass: root.classList.contains('dark'),
      body: read('body'),
      surface: read('main, #app')
    }
  })

  expect(palette.themeMode, `${label} theme mode dataset`).toBe(mode)
  expect(palette.hasDarkClass, `${label} dark class`).toBe(mode === 'dark')
  expect(palette.body, `${label} body computed colors`).not.toBeNull()
  expect(palette.surface, `${label} visible surface computed colors`).not.toBeNull()

  if (mode === 'dark') {
    expect(
      palette.body?.backgroundColor || palette.surface?.backgroundColor,
      `${label} dark mode should not render a pure white page shell`
    ).not.toBe('rgb(255, 255, 255)')
  }
}

// Manual-only capture harness. It does not compare baselines or run in release gates.
// Custom FsusBlog wrapper: replace it with a FsusUI-provided route screenshot harness once FsusUI exposes one.
test.describe('manual layout screenshot capture', () => {
  test.describe.configure({ mode: 'serial', timeout: 1_800_000 })

  test('captures every route for human layout review', async ({ browser }) => {
    const storageStates: Record<'anonymous' | 'user' | 'admin', StorageState | undefined> = {
      anonymous: undefined,
      user: await captureStorageState(browser, userName, userPassword, '/user/profile'),
      admin: await captureStorageState(browser, adminName, adminPassword, '/user/manage')
    }

    for (const viewport of viewports) {
      for (const theme of themes) {
        for (const routeSet of routeSets) {
          const routes = viewport.routeFilter
            ? routeSet.routes.filter(viewport.routeFilter)
            : routeSet.routes
          if (routes.length === 0) {
            continue
          }

          await captureRouteSet(browser, routes, storageStates[routeSet.storage], viewport, theme)
        }
      }
    }
  })
})

async function captureRouteSet(
  browser: Browser,
  routes: ManualRoute[],
  storageState: StorageState | undefined,
  viewport: ManualViewport,
  theme: ThemeMode
): Promise<void> {
  const session = await openThemedAuditedPage(browser, theme, storageState)

  try {
    for (const route of routes) {
      const start = session.audit.checkpoint()
      await captureRouteScreenshot(session.page, route, viewport, theme)
      // Manual boundary captures may intentionally render a missing-data state.
      // Keep the exception local so normal route screenshots still fail on runtime noise.
      if (!route.allowExpectedRuntimeNoise) {
        session.audit.assertCleanSince(start, `${route.name} ${viewport.name} ${theme}`)
      }
    }
  } finally {
    await session.close()
  }
}
