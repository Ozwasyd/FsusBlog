import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { APP_ROUTE_RECORDS } from '../../../../src/frontend/src/router/appRouteRecords'
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  NARROW_MOBILE_VIEWPORT,
  type StorageState,
  type ThemeMode,
  adminName,
  adminPassword,
  assertResponsiveLayoutContract,
  captureStorageState,
  ensureThemeApplied,
  freezeUiForScreenshot,
  normalizeDynamicEvidenceForScreenshot,
  openThemedAuditedPage,
  prewarmDevRuntime,
  settlePage,
  waitForPublicHydration,
  waitForScreenshotPaintStability,
  userName,
  userPassword,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import { loadAuditFixtures } from '../../support/playwright/routeAuditFixtures'
import {
  assertManualRouteScopeInvariants,
  buildManualRoutesFromRouteRecords,
  filterManualScreenshotItems,
  parseManualScreenshotFilter,
  shouldAssertManualResponsiveLayout,
  type ManualRoute,
  type ManualRouteScope,
  type ManualRouteStorage
} from '../../support/playwright/manualScreenshotRoutePlan'
import {
  normalizeManualScreenshotShardName,
  resolveDocsScreenshotRoot
} from '../../support/playwright/manualScreenshotConfiguration'

type ManualViewport = Readonly<{
  name: string
  size: typeof DESKTOP_VIEWPORT
  routeFilter?: (route: ManualRoute) => boolean
}>

const themes: ThemeMode[] = ['light', 'dark']
const strictRuntimeAudit = process.env.FSUSBLOG_MANUAL_SCREENSHOT_RUNTIME_AUDIT !== '0'
const strictLayoutAudit = process.env.FSUSBLOG_MANUAL_SCREENSHOT_LAYOUT_AUDIT !== '0'
const publicPreviewDocsCapture = process.env.FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE === '1'
const manualScreenshotShardName = normalizeManualScreenshotShardName(process.env.FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME)

if (process.env.FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS === '1') {
  throw new Error('manual screenshot shards cannot write docs assets; run npm run capture:public-preview-docs')
}

if (publicPreviewDocsCapture && (
  manualScreenshotShardName
  || process.env.FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS
  || process.env.FSUSBLOG_MANUAL_SCREENSHOT_THEMES
  || process.env.FSUSBLOG_MANUAL_SCREENSHOT_SCOPES
)) {
  throw new Error('public-preview docs capture requires the complete unfiltered registry')
}

const fixtures = loadAuditFixtures()

const viewports: ManualViewport[] = [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT },
  {
    name: 'narrow-mobile',
    size: NARROW_MOBILE_VIEWPORT,
    routeFilter: (route) => route.scope === 'edge'
  }
]
const selectedViewports = filterManualScreenshotItems(
  'viewport',
  viewports,
  (viewport) => viewport.name,
  parseManualScreenshotFilter('FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS', viewports.map((viewport) => viewport.name))
)
const selectedThemes = filterManualScreenshotItems(
  'theme',
  themes,
  (theme) => theme,
  parseManualScreenshotFilter('FSUSBLOG_MANUAL_SCREENSHOT_THEMES', themes)
)

const routeSets: Array<{
  scope: ManualRouteScope
  storage: ManualRouteStorage
  routes: ManualRoute[]
}> = buildManualRoutesFromRouteRecords(APP_ROUTE_RECORDS, fixtures)
assertManualRouteScopeInvariants(routeSets)
const selectedRouteSets = filterManualScreenshotItems(
  'scope',
  routeSets,
  (routeSet) => routeSet.scope,
  parseManualScreenshotFilter('FSUSBLOG_MANUAL_SCREENSHOT_SCOPES', routeSets.map((routeSet) => routeSet.scope))
)

const repositoryRoot = path.resolve(
  process.env.FSUSBLOG_REPOSITORY_ROOT
    ?? fileURLToPath(new URL('../../../..', import.meta.url))
)
const baseScreenshotRoot = path.resolve(
  process.env.FSUSBLOG_MANUAL_SCREENSHOT_DIR
    ?? path.join(repositoryRoot, '.tmp/manual-layout-screenshots/current')
)
const screenshotRoot = manualScreenshotShardName && !process.env.FSUSBLOG_MANUAL_SCREENSHOT_DIR
  ? path.join(baseScreenshotRoot, manualScreenshotShardName)
  : baseScreenshotRoot

const docsScreenshotRoot = resolveDocsScreenshotRoot({ publicPreviewDocsCapture })
const docsScreenshotRegistry = JSON.parse(readFileSync(
  path.join(repositoryRoot, 'config/docs/public-preview-screenshots.json'),
  'utf8'
)) as {
  screenshots: Array<{
    file: string
    route: string
    viewport: string
    theme: ThemeMode
    scope: ManualRouteScope
  }>
}
const docsScreenshotAliases = new Map(docsScreenshotRegistry.screenshots.map((entry) => [
  docsScreenshotAliasKey(entry.route, entry.viewport, entry.theme),
  entry.file
]))

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
  if (!publicPreviewDocsCapture || !docsScreenshotRoot) {
    return null
  }

  const alias = docsScreenshotAliases.get(docsScreenshotAliasKey(route.name, viewport.name, theme))
  return alias ? path.join(docsScreenshotRoot, alias) : null
}

function docsScreenshotAliasKey(routeName: string, viewportName: string, theme: ThemeMode): string {
  return `${routeName}|${viewportName}|${theme}`
}

function sanitizeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'route'
}

async function captureRouteScreenshot(page: Page, route: ManualRoute, viewport: ManualViewport, theme: ThemeMode): Promise<void> {
  await page.setViewportSize(viewport.size)
  await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' })
  await page.goto(route.path, { waitUntil: 'domcontentloaded' })
  // Edge-boundary routes (NotFound) intentionally serve the fail-closed 404
  // status page without the #app root, so the standard readiness and app-root
  // assertions cannot apply; only the theme-readable status surface is captured.
  if (route.scope === 'edge') {
    await page.waitForTimeout(1_000)
    // The fail-closed status page is static markup without the theme dataset
    // contract, so only paint stability and the raw surface are captured.
    await freezeUiForScreenshot(page)
    await waitForScreenshotPaintStability(page)
    const edgeOutputPath = screenshotPath(route, viewport, theme)
    const edgeDocsPath = docsScreenshotPath(route, viewport, theme)
    const edgeScreenshot = await page.screenshot({ fullPage: true, animations: 'disabled' as const, caret: 'hide' as const })
    await mkdir(path.dirname(edgeOutputPath), { recursive: true })
    await writeFile(edgeOutputPath, edgeScreenshot)
    if (edgeDocsPath) {
      await mkdir(path.dirname(edgeDocsPath), { recursive: true })
      await writeFile(edgeDocsPath, edgeScreenshot)
    }
    return
  }
  await waitForAppReady(page)
  await settlePage(page)
  if (await page.locator('#fsus-aot-shell').count() > 0) {
    // The search view keeps the shell hydration marker unset when its index
    // load fails, and the search manifest serving chain can hand a stale
    // generation to a fresh capture run (tracked separately). The layout
    // capture still proceeds on the hydrated shell surface.
    if (route.name !== 'Search') {
      await waitForPublicHydration(page)
    } else {
      await page.waitForTimeout(1_000)
    }
  }
  await waitForManualRouteContentReady(page, route)
  await ensureThemeApplied(page, theme)

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
  await assertContentDrivenCoverContract(page, route, viewport, theme)
  if (strictLayoutAudit && shouldAssertManualResponsiveLayout(route.name)) {
    await assertResponsiveLayoutContract(page, `${route.name} ${viewport.name} ${theme}`)
  }
  await freezeUiForScreenshot(page)
  await normalizeDynamicEvidenceForScreenshot(page)
  await waitForScreenshotPaintStability(page)

  const outputPath = screenshotPath(route, viewport, theme)
  const docsPath = docsScreenshotPath(route, viewport, theme)
  const screenshotOptions = {
    fullPage: true,
    animations: 'disabled' as const,
    caret: 'hide' as const
  }
  await page.screenshot(screenshotOptions)
  await waitForScreenshotPaintStability(page)
  // The warm-up full-page capture may activate lazy public islands that rewrite
  // relative-time text. Re-normalize the final frame after those writes settle.
  await normalizeDynamicEvidenceForScreenshot(page)
  await waitForScreenshotPaintStability(page)
  const screenshot = await page.screenshot(screenshotOptions)

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

    return Boolean(
      document.querySelector('[data-home-editorial-lead]')
      || document.querySelector('[data-home-editorial-secondary]')
    )
  }, undefined, { timeout: 15_000 })
}

async function assertContentDrivenCoverContract(
  page: Page,
  route: ManualRoute,
  viewport: ManualViewport,
  theme: ThemeMode
): Promise<void> {
  if (route.name !== 'Home' && route.name !== 'ArticleDetail') {
    return
  }

  const result = await page.evaluate(async () => {
    const containers = Array.from(document.querySelectorAll<HTMLElement>('[data-content-cover]'))
    const findings: string[] = []
    const luminance: number[] = []

    for (const container of containers) {
      const image = container.querySelector<HTMLImageElement>('img')
      if (!image) {
        findings.push('cover container has no image')
        continue
      }

      const source = image.currentSrc || image.src
      if (!source.trim()) findings.push('cover image has a blank source')
      if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        findings.push(`cover image did not load: ${source}`)
      }

      const containerStyle = getComputedStyle(container)
      const imageStyle = getComputedStyle(image)
      if (container.dataset.coverSafeArea !== 'center-80') findings.push('cover safe area is not center-80')
      if (imageStyle.objectFit !== 'cover') findings.push(`cover object-fit is ${imageStyle.objectFit}`)
      if (imageStyle.objectPosition !== '50% 50%') findings.push(`cover object-position is ${imageStyle.objectPosition}`)
      if (containerStyle.backgroundImage !== 'none') findings.push('cover container has a background image')
      if (!container.classList.contains('shadow-none')) findings.push('cover container does not explicitly disable shadows')
      if (imageStyle.filter !== 'none') findings.push('cover image has a runtime filter')
      if (containerStyle.borderTopStyle === 'none' || Number.parseFloat(containerStyle.borderTopWidth) < 1) {
        findings.push('cover container has no neutral boundary')
      }

      const heading = container.dataset.contentCover === 'editorial-lead'
        ? container.closest('a')?.querySelector<HTMLElement>('h1')
        : container.parentElement?.querySelector<HTMLElement>('header h1')
      if (heading) {
        const coverRect = container.getBoundingClientRect()
        const headingRect = heading.getBoundingClientRect()
        const overlaps = coverRect.left < headingRect.right
          && coverRect.right > headingRect.left
          && coverRect.top < headingRect.bottom
          && coverRect.bottom > headingRect.top
        if (overlaps) findings.push('cover overlaps the adjacent article heading')
        if (!heading.textContent?.trim() || getComputedStyle(heading).color === 'rgba(0, 0, 0, 0)') {
          findings.push('adjacent article heading is not readable')
        }
      }

      try {
        const sourceUrl = new URL(source, window.location.href)
        if (sourceUrl.origin === window.location.origin && sourceUrl.pathname.endsWith('.svg')) {
          const svg = await fetch(sourceUrl.href).then(async (response) => await response.text())
          for (const forbidden of ['<text', '<linearGradient', '<radialGradient', '<filter', '<feDropShadow']) {
            if (svg.includes(forbidden)) findings.push(`cover fixture contains forbidden ${forbidden}`)
          }
          if (!svg.includes('data-cover-concept=')) findings.push('cover fixture has no semantic concept marker')
        }

        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context && image.complete && image.naturalWidth > 0) {
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
          let weighted = 0
          let count = 0
          for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index + 3] === 0) continue
            weighted += (0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!) / 255
            count++
          }
          if (count > 0) luminance.push(weighted / count)
        }
      } catch (error) {
        findings.push(`cover inspection failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return {
      count: containers.length,
      findings,
      luminance
    }
  })

  expect(result.findings, `${route.name} ${viewport.name} ${theme} cover contract`).toEqual([])
  expect(result.count, `${route.name} should render at most one content cover`).toBeLessThanOrEqual(1)
  for (const value of result.luminance) {
    expect(value, `${route.name} ${theme} cover should retain visible detail`).toBeGreaterThan(0.08)
    expect(value, `${route.name} ${theme} cover should avoid a large bright block`).toBeLessThan(theme === 'dark' ? 0.62 : 0.82)
  }
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
    const menuButton = toggle.querySelector<HTMLElement>('.el-theme-mode-toggle__menu-button')
    const segmented = toggle.classList.contains('el-theme-mode-toggle--segmented')
    const menuButtonVariant = toggle.classList.contains('el-theme-mode-toggle--menu-button')
    const visibleControl = buttonInner ?? menuButton
    const selectedControl = checkedButtonInner ?? menuButton
    const rootStyle = getComputedStyle(document.documentElement)
    const inputStyle = input ? getComputedStyle(input) : null
    const buttonStyle = visibleControl ? getComputedStyle(visibleControl) : null
    const checkedButtonStyle = selectedControl ? getComputedStyle(selectedControl) : null

    return {
      present: true,
      variant: segmented ? 'segmented' : menuButtonVariant ? 'menu-button' : 'unknown',
      hasExpectedControl: segmented ? Boolean(buttonInner) : menuButtonVariant ? Boolean(menuButton) : false,
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

  expect(state.variant, `${label} theme mode toggle should declare a supported FsusUI variant`).not.toBe('unknown')
  expect(state.hasExpectedControl, `${label} theme mode toggle should use its FsusUI ${state.variant} DOM`).toBe(true)
  expect(state.rootBorderToken, `${label} theme mode toggle should load Element border token`).not.toBe('')
  expect(state.rootPrimaryToken, `${label} theme mode toggle should load Element primary token`).not.toBe('')
  expect(state.rootFillBlankToken, `${label} theme mode toggle should load Element fill token`).not.toBe('')
  if (state.variant === 'segmented') {
    expect(state.inputOpacity, `${label} theme mode toggle native radio should be visually hidden`).toBe('0')
    expect(state.inputPosition, `${label} theme mode toggle native radio should be removed from flow`).toBe('absolute')
    // FsusUI's segmented variant centers the label with an inline-flex pill
    // (theme-mode-toggle.scss), replacing the legacy inline-block baseline.
    expect(state.buttonDisplay, `${label} theme mode toggle segmented button should be styled`).toBe('inline-flex')
  } else {
    expect(['inline-flex', 'flex', 'inline-block', 'block'], `${label} theme mode menu button should be styled`).toContain(state.buttonDisplay)
  }
  if (typeof state.buttonPaddingInlineStart !== 'string') {
    throw new Error(`${label} theme mode toggle control should expose computed component padding`)
  }
  expect(Number.parseFloat(state.buttonPaddingInlineStart), `${label} theme mode toggle control should keep component padding`).toBeGreaterThanOrEqual(8)
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

    // The docs capture starts from a clean Vite transform cache. Warm the
    // registered anonymous public routes before the audited capture context so
    // a valid first route is not mistaken for a hydration hang while Vite and
    // the backend snapshot cache compile route-specific dependencies.
    const warmupPaths = publicPreviewDocsCapture
      ? [...new Set(selectedRouteSets
          .filter((routeSet) => routeSet.storage === 'anonymous')
          .flatMap((routeSet) => routeSet.routes)
          .filter((route) => selectedViewports.some((viewport) =>
            selectedThemes.some((theme) =>
              docsScreenshotAliases.has(docsScreenshotAliasKey(route.name, viewport.name, theme)))))
          .map((route) => route.path))]
      : ['/']
    await prewarmDevRuntime(browser, warmupPaths)

    for (const viewport of selectedViewports) {
      for (const theme of selectedThemes) {
        for (const routeSet of selectedRouteSets) {
          let routes = viewport.routeFilter
            ? routeSet.routes.filter(viewport.routeFilter)
            : routeSet.routes
          if (publicPreviewDocsCapture) {
            routes = routes.filter((route) => docsScreenshotAliases.has(
              docsScreenshotAliasKey(route.name, viewport.name, theme)
            ))
          }
          if (routes.length === 0) {
            continue
          }

          const storageState = await captureManualStorageState(browser, routeSet.storage)
          await captureRouteSet(browser, routes, storageState, viewport, theme)
        }
      }
    }
  })
})

async function captureManualStorageState(
  browser: Browser,
  storage: ManualRouteStorage
): Promise<StorageState | undefined> {
  if (storage === 'anonymous') {
    return undefined
  }

  if (storage === 'user') {
    return await captureStorageState(browser, userName, userPassword, '/user/profile')
  }

  return await captureStorageState(browser, adminName, adminPassword, '/user/manage')
}

async function captureRouteSet(
  browser: Browser,
  routes: ManualRoute[],
  storageState: StorageState | undefined,
  viewport: ManualViewport,
  theme: ThemeMode
): Promise<void> {
  // Match the quality writer's scenario isolation: a permanent screenshot
  // never inherits service-worker, locale, cache, or navigation state from
  // another route. The service worker is disabled because its search-index
  // cache can outlive a capture run's search generation and serve a stale
  // manifest, which fails the /search hydration readiness gate for reasons
  // unrelated to the layout under review.
  for (const route of routes) {
    const session = await openThemedAuditedPage(browser, theme, storageState, true)
    const start = session.audit.checkpoint()
    try {
      await captureRouteScreenshot(session.page, route, viewport, theme)
      // Manual boundary captures may intentionally render a missing-data state.
      // Keep the exception local so normal route screenshots still fail on runtime noise.
      if (strictRuntimeAudit && !route.allowExpectedRuntimeNoise) {
        session.audit.assertCleanSince(start, `${route.name} ${viewport.name} ${theme}`)
      }
    } catch (error) {
      const readiness = await session.page.evaluate(() => {
        const app = document.querySelector<HTMLElement>('#app')
        const loader = document.getElementById('global-loader')
        const diagnosticWindow = window as typeof window & {
          __FSUSBLOG_TEST_CONSOLE_ERRORS__?: readonly unknown[]
          __FSUSBLOG_PUBLIC_ROUTE_DIAGNOSTICS__?: readonly unknown[]
        }
        return {
          appChildCount: app?.childElementCount ?? null,
          appHeight: app?.getBoundingClientRect().height ?? null,
          documentReadyState: document.readyState,
          loaderHidden: loader?.hidden ?? null,
          pathname: window.location.pathname,
          consoleErrors: diagnosticWindow.__FSUSBLOG_TEST_CONSOLE_ERRORS__ ?? [],
          publicRouteDiagnostics: diagnosticWindow.__FSUSBLOG_PUBLIC_ROUTE_DIAGNOSTICS__ ?? []
        }
      }).catch(() => null)
      throw new Error(
        `manual route ${route.name} ${viewport.name} ${theme} failed at ${session.page.url()}; `
          + `readiness=${JSON.stringify(readiness)}; `
          + `runtimeEvents=${JSON.stringify(session.audit.eventsSince(start))}`,
        { cause: error }
      )
    } finally {
      await session.close()
    }
  }
}
