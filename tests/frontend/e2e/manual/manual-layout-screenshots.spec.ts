import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Browser, Page, StorageState } from '@playwright/test'
import type { RouteRecordRaw } from 'vue-router'
import { APP_ROUTE_RECORDS } from '../../../../src/frontend/src/router/index'
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
import { loadAuditFixtures, type PlaywrightAuditFixtures } from '../../support/playwright/routeAuditFixtures'

type ManualRouteScope = 'anonymous' | 'user' | 'admin' | 'edge'
type ManualRouteStorage = 'anonymous' | 'user' | 'admin'

type ManualRoute = {
  name: string
  path: string
  expectedUrl: string
  scope: ManualRouteScope
  allowExpectedRuntimeNoise?: boolean
}

type FlattenedRouteRecord = {
  name: string
  path: string
  meta: Record<string, unknown>
  redirect: RouteRecordRaw['redirect']
}

type ManualViewport = Readonly<{
  name: string
  size: typeof DESKTOP_VIEWPORT
  routeFilter?: (route: ManualRoute) => boolean
}>

const fixtures = loadAuditFixtures()
const themes: ThemeMode[] = ['light', 'dark']
const strictRuntimeAudit = process.env.FSUSBLOG_MANUAL_SCREENSHOT_RUNTIME_AUDIT !== '0'
const strictLayoutAudit = process.env.FSUSBLOG_MANUAL_SCREENSHOT_LAYOUT_AUDIT !== '0'
const writeDocsScreenshotAssets = process.env.FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS === '1'

const viewports: ManualViewport[] = [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT },
  {
    name: 'narrow-mobile',
    size: NARROW_MOBILE_VIEWPORT,
    routeFilter: (route) => route.scope === 'edge'
  }
]

const routeSets: Array<{
  scope: ManualRouteScope
  storage: ManualRouteStorage
  routes: ManualRoute[]
}> = buildManualRoutesFromRouteRecords(APP_ROUTE_RECORDS, fixtures)

const screenshotRoot = path.resolve(
  process.env.FSUSBLOG_MANUAL_SCREENSHOT_DIR
    ?? path.resolve(process.cwd(), '../../.tmp/manual-layout-screenshots/current')
)

const docsScreenshotRoot = path.resolve(process.cwd(), '../../docs/assets/screenshots')
const docsScreenshotAliases = new Map<string, string>([
  [docsScreenshotAliasKey('Home', 'desktop', 'light'), 'public-home-light.png'],
  [docsScreenshotAliasKey('ArticleDetail', 'desktop', 'light'), 'article-detail-light.png'],
  [docsScreenshotAliasKey('ArticleDetail', 'mobile', 'light'), 'article-detail-mobile.png'],
  [docsScreenshotAliasKey('Home', 'desktop', 'dark'), 'public-dark.png'],
  [docsScreenshotAliasKey('ManageDashboard', 'desktop', 'light'), 'admin-dashboard.png'],
  [docsScreenshotAliasKey('ManageWriteArticle', 'desktop', 'light'), 'article-editor.png'],
  [docsScreenshotAliasKey('ManageModerationComments', 'desktop', 'light'), 'comment-moderation.png'],
  [docsScreenshotAliasKey('ManageSecurityDashboard', 'desktop', 'light'), 'security-console.png'],
  [docsScreenshotAliasKey('ManageOpsHealth', 'desktop', 'light'), 'operations-status.png']
])

function buildManualRoutesFromRouteRecords(
  records: readonly RouteRecordRaw[],
  routeFixtures: PlaywrightAuditFixtures
): Array<{ scope: ManualRouteScope, storage: ManualRouteStorage, routes: ManualRoute[] }> {
  const flattened = flattenRouteRecords(records)
  const recordsByName = new Map(flattened.map((record) => [record.name, record]))
  const grouped: Record<ManualRouteScope, ManualRoute[]> = {
    anonymous: [],
    user: [],
    admin: [],
    edge: []
  }

  for (const routeRecord of flattened) {
    const pathValue = materializeRoutePath(routeRecord.name, routeRecord.path, routeFixtures)
    const scope = classifyManualRoute(routeRecord)
    grouped[scope].push({
      name: routeRecord.name,
      path: pathValue,
      expectedUrl: resolveExpectedUrl(routeRecord, recordsByName, routeFixtures, pathValue),
      scope,
      allowExpectedRuntimeNoise: scope === 'edge'
    })
  }

  return [
    { scope: 'anonymous', storage: 'anonymous', routes: grouped.anonymous },
    { scope: 'user', storage: 'user', routes: grouped.user },
    { scope: 'admin', storage: 'admin', routes: grouped.admin },
    { scope: 'edge', storage: 'anonymous', routes: grouped.edge }
  ]
}

function flattenRouteRecords(
  records: readonly RouteRecordRaw[],
  parentPath = '',
  parentMeta: Record<string, unknown> = {}
): FlattenedRouteRecord[] {
  const flattened: FlattenedRouteRecord[] = []

  for (const record of records) {
    const pathValue = joinRoutePath(parentPath, record.path)
    const meta = { ...parentMeta, ...(record.meta ?? {}) }

    if (record.name) {
      flattened.push({
        name: String(record.name),
        path: pathValue,
        meta,
        redirect: record.redirect
      })
    }

    if ('children' in record && Array.isArray(record.children)) {
      flattened.push(...flattenRouteRecords(record.children, pathValue, meta))
    }
  }

  return flattened
}

function joinRoutePath(parentPath: string, routePath: string): string {
  if (routePath.startsWith('/')) {
    return normalizeRoutePath(routePath)
  }

  if (!parentPath || parentPath === '/') {
    return normalizeRoutePath(`/${routePath}`)
  }

  if (!routePath) {
    return normalizeRoutePath(parentPath)
  }

  return normalizeRoutePath(`${parentPath.replace(/\/+$/u, '')}/${routePath}`)
}

function normalizeRoutePath(value: string): string {
  const normalized = value.replace(/\/{2,}/gu, '/')
  return normalized === '' ? '/' : normalized
}

function materializeRoutePath(
  routeName: string,
  pathPattern: string,
  routeFixtures: PlaywrightAuditFixtures
): string {
  if (pathPattern.includes(':pathMatch')) {
    return '/route/that/does/not/exist/with/a/very/long/path/segment'
  }

  let routePath = pathPattern.replace(/:id(?:\([^)]*\))?/gu, () => dynamicRouteId(routeName, pathPattern, routeFixtures))
  if (routeName === 'Search') {
    routePath = `${routePath}?q=${encodeURIComponent(routeFixtures.searchKeyword)}`
  }

  return routePath
}

function dynamicRouteId(routeName: string, pathPattern: string, routeFixtures: PlaywrightAuditFixtures): string {
  if (routeName === 'ArticleDetail' || routeName === 'ManageEditArticle' || pathPattern.includes('/article/')) {
    return routeFixtures.articleId
  }

  if (routeName === 'Category' || pathPattern.includes('/category/')) {
    return routeFixtures.categoryId
  }

  if (routeName === 'Tag') {
    return 'fsus-ui-1-4-0-edge'
  }

  if (routeName === 'TagById' || pathPattern.includes('/tag/')) {
    return routeFixtures.tagId
  }

  return routeFixtures.articleId
}

function classifyManualRoute(record: FlattenedRouteRecord): ManualRouteScope {
  if (record.name === 'NotFound' || record.path.includes(':pathMatch')) {
    return 'edge'
  }

  const roles = Array.isArray(record.meta.roles)
    ? record.meta.roles.map(String)
    : []

  if (record.path.startsWith('/user/manage') || roles.includes('admin')) {
    return 'admin'
  }

  if (record.path.startsWith('/user') || record.meta.requiresAuth === true) {
    return 'user'
  }

  return 'anonymous'
}

function resolveExpectedUrl(
  record: FlattenedRouteRecord,
  recordsByName: ReadonlyMap<string, FlattenedRouteRecord>,
  routeFixtures: PlaywrightAuditFixtures,
  fallbackUrl: string
): string {
  const redirect = record.redirect
  if (!redirect || typeof redirect === 'function') {
    return fallbackUrl
  }

  if (typeof redirect === 'string') {
    return materializeRoutePath(record.name, redirect, routeFixtures)
  }

  if ('path' in redirect && typeof redirect.path === 'string') {
    return `${materializeRoutePath(record.name, redirect.path, routeFixtures)}${stringifyQuery(redirect.query)}`
  }

  if ('name' in redirect && redirect.name) {
    const target = recordsByName.get(String(redirect.name))
    if (target) {
      return `${materializeRoutePath(target.name, target.path, routeFixtures)}${stringifyQuery(redirect.query)}`
    }
  }

  return fallbackUrl
}

function stringifyQuery(query: unknown): string {
  if (!query || typeof query !== 'object') {
    return ''
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          params.append(key, String(item))
        }
      }
      continue
    }

    if (value !== undefined && value !== null) {
      params.set(key, String(value))
    }
  }

  const queryString = params.toString()
  return queryString ? `?${queryString}` : ''
}

function screenshotPath(route: ManualRoute, viewport: ManualViewport, theme: ThemeMode): string {
  return path.join(
    screenshotRoot,
    viewport.name,
    theme,
    route.scope,
    `${sanitizeFilename(route.name)}.png`
  )
}

function docsScreenshotPath(route: ManualRoute, viewport: ManualViewport, theme: ThemeMode): string | null {
  if (!writeDocsScreenshotAssets) {
    return null
  }

  const alias = docsScreenshotAliases.get(docsScreenshotAliasKey(route.name, viewport.name, theme))
  return alias ? path.join(docsScreenshotRoot, alias) : null
}

async function pruneStaleDocsScreenshotAssets(): Promise<void> {
  if (!writeDocsScreenshotAssets) {
    return
  }

  const currentAliases = new Set<string>()
  for (const viewport of viewports) {
    for (const theme of themes) {
      for (const routeSet of routeSets) {
        const routes = viewport.routeFilter
          ? routeSet.routes.filter(viewport.routeFilter)
          : routeSet.routes
        for (const route of routes) {
          const docsPath = docsScreenshotPath(route, viewport, theme)
          if (docsPath) {
            currentAliases.add(path.basename(docsPath))
          }
        }
      }
    }
  }

  await mkdir(docsScreenshotRoot, { recursive: true })
  const entries = await readdir(docsScreenshotRoot, { withFileTypes: true })
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png') && !currentAliases.has(entry.name))
    .map((entry) => rm(path.join(docsScreenshotRoot, entry.name), { force: true })))
}

function docsScreenshotAliasKey(routeName: string, viewportName: string, theme: ThemeMode): string {
  return `${routeName}|${viewportName}|${theme}`
}

function sanitizeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'route'
}

async function captureRouteScreenshot(page: Page, route: ManualRoute, viewport: ManualViewport, theme: ThemeMode): Promise<void> {
  await page.setViewportSize(viewport.size)
  await page.goto(route.path, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
  await settlePage(page)
  await waitForManualRouteContentReady(page, route)

  const expectedUrl = new URL(route.expectedUrl, 'http://127.0.0.1')
  await expect
    .poll(() => new URL(page.url()).pathname, { message: `${route.name} should land on expected route before manual screenshot capture` })
    .toBe(expectedUrl.pathname)

  if (expectedUrl.search) {
    await expect
      .poll(() => new URL(page.url()).search, { message: `${route.name} should preserve expected route query before manual screenshot capture` })
      .toBe(expectedUrl.search)
  }

  await expect(page.locator('#app'), `${route.name} should render one app root`).toHaveCount(1)
  await assertManualThemeReadable(page, theme, route.name)
  await assertThemeModeToggleStyled(page, route.name)
  if (strictLayoutAudit) {
    await assertResponsiveLayoutContract(page, `${route.name} ${viewport.name} ${theme}`)
  }
  await freezeUiForScreenshot(page)

  const outputPath = screenshotPath(route, viewport, theme)
  const docsPath = docsScreenshotPath(route, viewport, theme)
  const screenshot = await page.screenshot({
    fullPage: true,
    animations: 'disabled',
    caret: 'hide'
  })

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, screenshot)

  if (docsPath) {
    await mkdir(path.dirname(docsPath), { recursive: true })
    await writeFile(docsPath, screenshot)
  }
}

async function waitForManualRouteContentReady(page: Page, route: ManualRoute): Promise<void> {
  if (route.name !== 'Home') {
    return
  }

  await waitForHomeSecondaryContent(page)
}

async function waitForHomeSecondaryContent(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const hasHomeArticle = document.querySelectorAll('#fsus-home-main-column a[href^="/article/"]').length > 0
    if (!hasHomeArticle) {
      return true
    }

    const hasMainSecondary = Boolean(
      document.querySelector('.featured-articles-section')
      || document.querySelector('.home-text-first-recommendations')
    )
    if (!hasMainSecondary) {
      return false
    }

    const asideHost = document.getElementById('fsus-home-hot-articles-slot')
    if (!asideHost) {
      return true
    }

    return Boolean(
      document.querySelector('[data-dynamic-island="home-hot-articles"]')
      || document.querySelector('[data-home-hot-articles-aside]')
    )
  }, undefined, { timeout: 15_000 })
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

async function assertThemeModeToggleStyled(page: Page, label: string): Promise<void> {
  const state = await page.evaluate(() => {
    const toggle = document.querySelector('.el-theme-mode-toggle')
    if (!toggle) {
      return { present: false }
    }

    const input = toggle.querySelector<HTMLInputElement>('input[type="radio"]')
    const buttonInner = toggle.querySelector<HTMLElement>('.el-radio-button__inner')
    const checkedButtonInner = toggle.querySelector<HTMLElement>('.el-radio-button__original-radio:checked + .el-radio-button__inner')
    const rootStyle = getComputedStyle(document.documentElement)
    const inputStyle = input ? getComputedStyle(input) : null
    const buttonStyle = buttonInner ? getComputedStyle(buttonInner) : null
    const checkedButtonStyle = checkedButtonInner ? getComputedStyle(checkedButtonInner) : null

    return {
      present: true,
      hasRadioButtonInner: Boolean(buttonInner),
      rootBorderToken: rootStyle.getPropertyValue('--el-border').trim(),
      rootPrimaryToken: rootStyle.getPropertyValue('--el-color-primary').trim(),
      rootFillBlankToken: rootStyle.getPropertyValue('--el-fill-color-blank').trim(),
      inputOpacity: inputStyle?.opacity ?? '',
      inputPosition: inputStyle?.position ?? '',
      inputZIndex: inputStyle?.zIndex ?? '',
      buttonDisplay: buttonStyle?.display ?? '',
      buttonPaddingInlineStart: buttonStyle?.paddingInlineStart ?? '',
      checkedBackgroundColor: checkedButtonStyle?.backgroundColor ?? '',
      checkedTextColor: checkedButtonStyle?.color ?? '',
      text: toggle.textContent?.trim() ?? ''
    }
  })

  if (!state.present) {
    return
  }

  expect(state.hasRadioButtonInner, `${label} theme mode toggle should use FsusUI radio-button DOM`).toBe(true)
  expect(state.rootBorderToken, `${label} theme mode toggle should load Element border token`).not.toBe('')
  expect(state.rootPrimaryToken, `${label} theme mode toggle should load Element primary token`).not.toBe('')
  expect(state.rootFillBlankToken, `${label} theme mode toggle should load Element fill token`).not.toBe('')
  expect(state.inputOpacity, `${label} theme mode toggle native radio should be visually hidden`).toBe('0')
  expect(state.inputPosition, `${label} theme mode toggle native radio should be removed from flow`).toBe('absolute')
  expect(state.buttonDisplay, `${label} theme mode toggle segmented button should be styled`).toBe('inline-block')
  expect(Number.parseFloat(state.buttonPaddingInlineStart), `${label} theme mode toggle segmented button should keep component padding`).toBeGreaterThanOrEqual(8)
  expect(state.checkedBackgroundColor, `${label} theme mode toggle selected segment should have themed background`).not.toBe('')
  expect(state.checkedBackgroundColor, `${label} theme mode toggle selected segment should not be transparent`).not.toBe('rgba(0, 0, 0, 0)')
  expect(state.checkedTextColor, `${label} theme mode toggle selected segment should have themed text color`).not.toBe('')
}

// Manual-only capture harness. It does not compare baselines or run in release gates.
// Route coverage is derived from the frontend router table so screenshot review follows the app surface.
test.describe('manual layout screenshot capture', () => {
  test.describe.configure({ mode: 'serial' })

  test('captures every route for human layout review', async ({ browser }) => {
    test.setTimeout(1_800_000)

    await pruneStaleDocsScreenshotAssets()

    const storageStates: Record<ManualRouteStorage, StorageState | undefined> = {
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
      if (strictRuntimeAudit && !route.allowExpectedRuntimeNoise) {
        session.audit.assertCleanSince(start, `${route.name} ${viewport.name} ${theme}`)
      }
    }
  } finally {
    await session.close()
  }
}
