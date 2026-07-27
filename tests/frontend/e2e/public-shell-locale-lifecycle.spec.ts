import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/publicShellLocaleLifecycle.ts', import.meta.url)
).replaceAll('\\', '/')}`

// Catalog-backed sample: not a hard-coded bilingual inventory.
const localeCatalog = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../src/shared/Contracts/Localization/locale-catalog.json', import.meta.url)),
  'utf8',
)) as {
  locales: ReadonlyArray<Readonly<{ code: string; status: string }>>
}
const catalogCodes = localeCatalog.locales
  .filter((locale) => locale.status === 'enabled')
  .map((locale) => locale.code)
const sampledLocales = Array.from(new Set([
  catalogCodes.find((code) => code === 'ja-JP') ?? catalogCodes[0]!,
  catalogCodes.find((code) => code === 'de-DE') ?? catalogCodes[Math.min(1, catalogCodes.length - 1)]!,
  catalogCodes[catalogCodes.length - 1]!,
]))

type FixtureSession = 'anonymous' | 'user'
type FixturePhase = 'aot' | 'hydrated' | 'spa'

async function openFixture(
  page: Page,
  locale: string,
  session: FixtureSession,
): Promise<readonly string[]> {
  const runtimeErrors: string[] = []
  const isViteTransportError = (message: string): boolean => (
    message.includes('WebSocket connection to')
    || message.includes('[vite] failed to connect to websocket')
    || message.includes('Failed to send error to Vite server')
  )
  page.on('console', (message) => {
    if (message.type() === 'error' && !isViteTransportError(message.text())) {
      runtimeErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  await page.route('**/api/**', (route) => route.abort('blockedbyclient'))
  await page.route('**/__public-shell-locale-fixture**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html>
      <html lang="${locale}">
        <head><meta charset="utf-8"><title>PublicShell locale lifecycle</title></head>
        <body>
          <div id="public-shell-locale-fixture"></div>
          <script type="module" src="${fixtureModule}"></script>
        </body>
      </html>`,
  }))
  await page.goto(`/__public-shell-locale-fixture?locale=${locale}&session=${session}`)
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.dataset.publicShellLocaleFixtureReady
  )).toBe('true')
  return runtimeErrors
}

async function advance(page: Page, phase: FixturePhase): Promise<void> {
  await page.evaluate(async (next) => {
    const fixtureWindow = window as Window & {
      __advancePublicShellPhase?: (value: FixturePhase) => Promise<void>
    }
    if (!fixtureWindow.__advancePublicShellPhase) {
      throw new Error('public_shell_locale_fixture_controller_missing')
    }
    await fixtureWindow.__advancePublicShellPhase(next)
  }, phase)
  await expect(page.locator('#fixture-content')).toHaveAttribute('data-fixture-phase', phase)
}

async function headerGeometry(page: Page) {
  return await page.locator('[data-public-sticky-geometry-owner]').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

async function attachPhaseScreenshot(
  page: Page,
  testInfo: TestInfo,
  label: string,
): Promise<void> {
  const evidenceDirectory = process.env.FSUSBLOG_PUBLIC_SHELL_LOCALE_EVIDENCE_DIR
  if (evidenceDirectory) {
    const screenshotPath = path.join(path.resolve(evidenceDirectory), `${label}.png`)
    mkdirSync(path.dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: false })
    await testInfo.attach(`${label}.png`, { path: screenshotPath, contentType: 'image/png' })
    return
  }

  await testInfo.attach(`${label}.png`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  })
}

async function assertSelectorCatalog(page: Page, locale: string, width: number): Promise<void> {
  if (width < 768) {
    await page.locator('[data-mobile-nav-menu-trigger]').click()
  }

  const adapter = page.locator('[data-locale-selector-runtime-adapter]').first()
  await expect(adapter).toBeVisible()
  await expect(adapter).toHaveAttribute('data-active-locale', locale)

  const trigger = page.locator('[data-locale-selector-trigger]').first()
  await expect(trigger).toBeVisible()
  await trigger.click()

  const itemCodes = await page.locator('[data-locale-selector-item]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-locale-code') ?? '')
  )
  // Items are projected once per selector instance; read unique codes in catalog order.
  const uniqueCodes = [...new Set(itemCodes)]
  expect(uniqueCodes).toEqual(catalogCodes)
  expect(uniqueCodes).toHaveLength(catalogCodes.length)

  // Close menu to restore chrome for geometry checks.
  await page.keyboard.press('Escape')
  if (width < 768) {
    // Leave mobile menu open so utilities remain in layout if needed; re-close via summary.
    const menu = page.locator('[data-mobile-nav-menu-trigger]')
    if (await menu.getAttribute('aria-expanded') === 'true' || await menu.evaluate((el) => (el as HTMLDetailsElement).open ?? el.closest('details')?.open)) {
      await menu.click()
    }
  }
}

test.describe('PublicShell locale lifecycle', () => {
  for (const width of [320, 375, 768, 1440]) {
    for (const locale of sampledLocales) {
      for (const session of ['anonymous', 'user'] as const) {
        test(`${width}px ${locale} ${session} keeps one copy authority`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width, height: 900 })
          const runtimeErrors = await openFixture(page, locale, session)
          const geometries: Array<Awaited<ReturnType<typeof headerGeometry>>> = []

          for (const phase of ['aot', 'hydrated', 'spa'] as const) {
            await advance(page, phase)
            const shell = page.locator('#fsus-aot-shell')
            await expect(shell).toHaveAttribute('data-public-mobile-menu-message-key', 'public.shell.mobileMenu')
            await expect(shell).toHaveAttribute('data-public-search-message-key', 'public.shell.search')
            await expect(shell).toHaveAttribute(
              'data-public-auth-message-key',
              session === 'anonymous' ? 'public.shell.login' : 'public.shell.account',
            )
            await expect(page.locator('html')).toHaveAttribute('lang', locale)

            // Auth/menu/search labels come from the active locale bundle, not a bilingual table.
            await expect(page.locator('a[data-public-nav="auth"]').first()).not.toHaveText('')
            await expect(page.locator('[data-mobile-nav-menu-trigger]')).not.toHaveText('')
            await expect(page.locator('.el-public-shell__mobile-search-trigger')).not.toHaveText('')

            if (width < 768) {
              await expect(page.locator('[data-mobile-nav-menu-trigger]')).toBeVisible()
              await expect(page.locator('.el-public-shell__mobile-search-trigger')).toBeVisible()
            } else {
              await expect(page.locator('.el-public-shell__desktop-search-trigger')).toBeVisible()
              await expect(page.locator('[data-locale-selector-runtime-adapter]').first()).toBeVisible()
            }

            await assertSelectorCatalog(page, locale, width)

            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
              .toBeLessThanOrEqual(1)
            const visibleActionGeometry = await page.locator(
              [
                '[data-public-shell-header] .el-public-shell__desktop-search-trigger',
                '[data-public-shell-header] .el-public-shell__mobile-search-trigger',
                '[data-public-shell-header] [data-mobile-nav-menu-trigger]',
                '[data-public-shell-header] .el-public-shell__auth-link',
                '[data-public-shell-header] .el-theme-mode-toggle__menu-button',
                '[data-public-shell-header] [data-locale-selector-trigger]',
              ].join(','),
            ).evaluateAll((elements) => elements
              .filter((element) => element.getBoundingClientRect().height > 0)
              .map((element) => {
                const style = getComputedStyle(element)
                return {
                  fontSize: Number.parseFloat(style.fontSize),
                  fontWeight: Number.parseInt(style.fontWeight, 10),
                  height: element.getBoundingClientRect().height,
                }
              }))
            // Mobile header keeps search + menu; desktop keeps search + auth + theme + locale.
            expect(visibleActionGeometry.length).toBeGreaterThanOrEqual(width < 768 ? 2 : 3)
            expect(visibleActionGeometry.every(({ height }) => Math.abs(height - 44) <= 1)).toBe(true)
            geometries.push(await headerGeometry(page))
            await attachPhaseScreenshot(page, testInfo, `${width}-${locale}-${session}-${phase}`)
          }

          const initial = geometries[0]!
          for (const geometry of geometries.slice(1)) {
            expect(Math.abs(geometry.x - initial.x)).toBeLessThanOrEqual(1)
            expect(Math.abs(geometry.y - initial.y)).toBeLessThanOrEqual(1)
            expect(Math.abs(geometry.width - initial.width)).toBeLessThanOrEqual(1)
            expect(Math.abs(geometry.height - initial.height)).toBeLessThanOrEqual(1)
          }
          expect(runtimeErrors).toEqual([])
          await expect(page).toHaveTitle('PublicShell locale lifecycle')
          await expect(page.locator('vite-error-overlay, #vite-error-overlay')).toHaveCount(0)
        })
      }
    }
  }
})
