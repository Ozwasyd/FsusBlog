import { expect, test, type Browser } from '@playwright/test'
import type { RouteRecordRaw } from 'vue-router'

import { APP_ROUTE_RECORDS } from '../../../../src/frontend/src/router/appRouteRecords'
import {
  adminName,
  adminPassword,
  captureStorageState,
  ensureThemeApplied,
  freezeUiForScreenshot,
  normalizeDynamicEvidenceForScreenshot,
  openThemedAuditedPage,
  settlePage,
  userName,
  userPassword,
  waitForAppReady,
  waitForPublicHydration,
  waitForScreenshotPaintStability,
  type StorageState,
  type ThemeMode
} from '../../support/playwright/acceptance-shared'
import { loadAuditFixtures, type PlaywrightAuditFixtures } from '../../support/playwright/routeAuditFixtures'
import { resolveDocsScreenshotRoot } from '../../support/playwright/manualScreenshotConfiguration'
import { loadPublicPreviewRegistry } from '../../../../tools/docs/public-preview-registry.mjs'
import {
  applyPublicPreviewZoom,
  auditPublicPreviewPage,
  createPublicPreviewQualityMatrix,
  measurePublicPreviewHeader,
  writePublicPreviewQualityMatrix,
  writePublicPreviewQualitySidecar,
  type PublicPreviewQualityReport,
  type PublicPreviewQualityScenario
} from '../../../../tools/docs/public-preview-quality.mjs'

type RouteTarget = {
  name: string
  path: string
}

const publicPreviewDocsCapture = process.env.FSUSBLOG_PUBLIC_PREVIEW_DOCS_CAPTURE === '1'
const qualityOnly = process.env.FSUSBLOG_PUBLIC_PREVIEW_QUALITY_ONLY === '1'
const strictRuntimeAudit = process.env.FSUSBLOG_MANUAL_SCREENSHOT_RUNTIME_AUDIT !== '0'
const outputDirectory = resolveDocsScreenshotRoot({ publicPreviewDocsCapture })
const registry = loadPublicPreviewRegistry(new URL('../../../..', import.meta.url))
const fixtures = loadAuditFixtures()
const routes = new Map(flattenRoutes(APP_ROUTE_RECORDS).map((route) => [route.name, route]))

test.describe('public-preview quality capture', () => {
  test.skip(!publicPreviewDocsCapture, 'quality capture only runs through the governed public-preview writer')

  test('writes per-image audits and the complete quality matrix', async ({ browser }) => {
    test.setTimeout(1_800_000)
    if (!outputDirectory) throw new Error('public-preview quality output directory is missing')

    if (!qualityOnly) {
      for (const entry of registry.screenshots) {
        const report = await captureScenario(browser, {
          ...entry,
          viewport: entry.qualityViewport
        })
        await writePublicPreviewQualitySidecar(outputDirectory, entry.file, report)
        expect(
          report.status,
          `${entry.id} public-preview quality: ${qualityFailureSummary(report)}`
        ).toBe('pass')
      }
    }

    const tier = process.env.FSUSBLOG_PUBLIC_PREVIEW_QUALITY_TIER?.trim() || 'release'
    const scenarios = registry.qualityScenarios.filter((scenario) => tier === 'release' || scenario.tier === 'quick')
    const reports: PublicPreviewQualityReport[] = []
    for (const scenario of scenarios) reports.push(await captureScenario(browser, scenario))

    const matrix = createPublicPreviewQualityMatrix(reports)
    await writePublicPreviewQualityMatrix(outputDirectory, matrix)
    expect(
      matrix.status,
      `public-preview quality matrix: ${JSON.stringify(reports
        .filter((report) => report.status !== 'pass')
        .map((report) => ({
          id: report.id,
          machineFailures: machineFailureDetails(report),
          reviewerReasons: report.reviewer.reasons
        })))}`
    ).toBe('pass')
  })
})

function qualityFailureSummary(report: PublicPreviewQualityReport): string {
  return JSON.stringify({
    machineFailures: machineFailureDetails(report),
    reviewerReasons: report.reviewer.reasons
  })
}

function machineFailureDetails(report: PublicPreviewQualityReport) {
  return Object.entries(report.machine)
    .filter(([, result]) => result.status !== 'pass')
    .map(([name, result]) => ({ name, result }))
}

async function captureScenario(
  browser: Browser,
  scenario: PublicPreviewQualityScenario
): Promise<PublicPreviewQualityReport> {
  const target = routes.get(scenario.route)
  if (!target) throw new Error(`public-preview quality route is not registered: ${scenario.route}`)
  const path = materializeRoute(target, fixtures)
  const storageState = await resolveStorageState(browser, scenario.scope)
  const session = await openThemedAuditedPage(browser, scenario.theme as ThemeMode, storageState)
  try {
    await session.page.context().addCookies([{
      name: 'fsusblog.locale',
      value: scenario.locale,
      url: process.env.PLAYWRIGHT_BASE_URL
        || process.env.FSUSBLOG_PUBLIC_BASE_URL
        || 'http://127.0.0.1:3000',
      httpOnly: true,
      sameSite: 'Lax'
    }])
    await session.page.setViewportSize(scenario.viewport)
    const checkpoint = session.audit.checkpoint()
    await session.page.goto(path, { waitUntil: 'domcontentloaded' })
    await applyPublicPreviewZoom(session.page, scenario.zoom)
    const headerSamples = [await measurePublicPreviewHeader(session.page, 'domcontentloaded')]
    try {
      await waitForAppReady(session.page)
    } catch (error) {
      const readiness = await session.page.evaluate(() => {
        const app = document.querySelector('#app')
        const loader = document.getElementById('global-loader')
        const appRect = app?.getBoundingClientRect()
        const diagnostics = window as typeof window & {
          __FSUSBLOG_PUBLIC_ROUTE_DIAGNOSTICS__?: Array<Readonly<{
            name: string
            error?: string
            target?: string
          }>>
          __FSUSBLOG_TEST_CONSOLE_ERRORS__?: Array<Readonly<{
            message: string
            name: string
            stack: string[]
          }>>
        }
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
            : null,
          publicRouteDiagnostics: diagnostics.__FSUSBLOG_PUBLIC_ROUTE_DIAGNOSTICS__ ?? [],
          consoleErrors: diagnostics.__FSUSBLOG_TEST_CONSOLE_ERRORS__ ?? []
        }
      })
      throw new Error(
        `public-preview readiness failed scenario=${scenario.id} diagnostics=${JSON.stringify({
          readiness,
          runtimeEvents: session.audit.eventsSince(checkpoint)
        })}`,
        { cause: error }
      )
    }
    headerSamples.push(await measurePublicPreviewHeader(session.page, 'application-ready'))
    await settlePage(session.page)
    if (await session.page.locator('#fsus-aot-shell').count() > 0) {
      await waitForPublicHydration(session.page)
    }
    await ensureThemeApplied(session.page, scenario.theme as ThemeMode)
    await freezeUiForScreenshot(session.page)
    await normalizeDynamicEvidenceForScreenshot(session.page)
    await waitForScreenshotPaintStability(session.page)
    headerSamples.push(await measurePublicPreviewHeader(session.page, 'stable-frame'))

    const report = await auditPublicPreviewPage(session.page, scenario, registry.qualityPolicy, { headerSamples })
    if (strictRuntimeAudit) session.audit.assertCleanSince(checkpoint, `public-preview quality ${scenario.id}`)
    return report
  } finally {
    await session.close()
  }
}

async function resolveStorageState(browser: Browser, scope?: string): Promise<StorageState | undefined> {
  if (scope === 'admin') return await captureStorageState(browser, adminName, adminPassword, '/user/manage')
  if (scope === 'user') return await captureStorageState(browser, userName, userPassword, '/user/profile')
  return undefined
}

function flattenRoutes(records: readonly RouteRecordRaw[], parentPath = ''): RouteTarget[] {
  const result: RouteTarget[] = []
  for (const record of records) {
    const path = joinRoutePath(parentPath, record.path)
    if (record.name) result.push({ name: String(record.name), path })
    if ('children' in record && Array.isArray(record.children)) result.push(...flattenRoutes(record.children, path))
  }
  return result
}

function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return normalizePath(child)
  if (!parent || parent === '/') return normalizePath(`/${child}`)
  if (!child) return normalizePath(parent)
  return normalizePath(`${parent.replace(/\/+$/u, '')}/${child}`)
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\/{2,}/gu, '/')
  return normalized || '/'
}

function materializeRoute(route: RouteTarget, auditFixtures: PlaywrightAuditFixtures): string {
  return route.path.replace(/:id(?:\([^)]*\))?/gu, () => {
    if (route.name === 'ArticleDetail' || route.name === 'ManageEditArticle' || route.path.includes('/article/')) {
      return auditFixtures.articleId
    }
    if (route.name === 'Category' || route.path.includes('/category/')) return auditFixtures.categoryId
    if (route.name === 'TagById' || route.path.includes('/tag/')) return auditFixtures.tagId
    return auditFixtures.articleId
  })
}
