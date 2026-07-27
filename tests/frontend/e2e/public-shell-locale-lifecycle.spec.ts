import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/publicShellLocaleLifecycle.ts', import.meta.url)
).replaceAll('\\', '/')}`

type FixtureLocale = 'en-US' | 'zh-CN'
type FixtureSession = 'anonymous' | 'user'
type FixturePhase = 'aot' | 'hydrated' | 'spa'

const expectedCopy = {
  'en-US': {
    anonymous: 'Log in',
    user: 'Account',
    menu: 'Menu',
    search: 'Search',
  },
  'zh-CN': {
    anonymous: '登录',
    user: '账户',
    menu: '菜单',
    search: '搜索',
  },
} as const

async function openFixture(
  page: Page,
  locale: FixtureLocale,
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

test.describe('PublicShell locale lifecycle', () => {
  for (const width of [320, 375, 768, 1440]) {
    for (const locale of ['en-US', 'zh-CN'] as const) {
      for (const session of ['anonymous', 'user'] as const) {
        test(`${width}px ${locale} ${session} keeps one copy authority`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width, height: 900 })
          const runtimeErrors = await openFixture(page, locale, session)
          const copy = expectedCopy[locale]
          const expectedAuth = copy[session]
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
            await expect(page.locator('a[data-public-nav="auth"]').first()).toHaveText(expectedAuth)
            await expect(page.locator('[data-mobile-nav-menu-trigger]')).toHaveText(copy.menu)
            await expect(page.locator('.el-public-shell__mobile-search-trigger')).toHaveText(copy.search)
            if (width < 768) {
              await expect(page.locator('[data-mobile-nav-menu-trigger]')).toBeVisible()
              await expect(page.locator('.el-public-shell__mobile-search-trigger')).toBeVisible()
            } else {
              await expect(page.locator('.el-public-shell__desktop-search-trigger')).toBeVisible()
            }
            await expect(page.locator('html')).toHaveAttribute('lang', locale)
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
              .toBeLessThanOrEqual(1)
            const visibleActionGeometry = await page.locator(
              [
                '[data-public-shell-header] .el-public-shell__desktop-search-trigger',
                '[data-public-shell-header] .el-public-shell__mobile-search-trigger',
                '[data-public-shell-header] [data-mobile-nav-menu-trigger]',
                '[data-public-shell-header] .el-public-shell__auth-link',
                '[data-public-shell-header] .el-theme-mode-toggle__menu-button',
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
            expect(visibleActionGeometry).toHaveLength(width < 768 ? 2 : 3)
            expect(visibleActionGeometry.every(({ fontSize }) => fontSize === 14)).toBe(true)
            expect(visibleActionGeometry.every(({ fontWeight }) => fontWeight === 500)).toBe(true)
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
