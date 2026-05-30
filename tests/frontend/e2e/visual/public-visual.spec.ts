import { test, expect } from '@playwright/test'
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  ThemeMode,
  WARMUP_TIMEOUT_MS,
  assertElementInViewport,
  assertNoHorizontalOverflow,
  assertThemeReadable,
  expectStableScreenshot,
  openThemedAuditedPage,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

const articlePath = `/article/${process.env.FSUSBLOG_VISUAL_ARTICLE_ID || '1'}`

const viewports = [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT }
] as const

const themes: ThemeMode[] = ['light', 'dark']

const routes = [
  { path: '/', label: 'public-home', primary: 'main header' },
  { path: articlePath, label: 'public-article', primary: 'main' },
  { path: '/login', label: 'public-login', primary: 'main' }
] as const

for (const viewport of viewports) {
  for (const theme of themes) {
    test.describe(`public visual (${viewport.name}, ${theme})`, () => {
      test.use({ viewport: viewport.size })
      test.describe.configure({ timeout: 240_000 })

      test('key public pages keep visual contract', async ({ browser }) => {
        for (const route of routes) {
          const session = await openThemedAuditedPage(browser, theme)

          try {
            await session.page.goto(route.path, { waitUntil: 'domcontentloaded' })
            await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
            await settlePage(session.page)

            const primary = session.page.locator(route.primary).first()
            await expect(primary).toBeVisible()
            await assertThemeReadable(session.page, theme)
            await assertNoHorizontalOverflow(session.page, viewport.name === 'mobile' ? 6 : 4)
            await assertElementInViewport(session.page, primary, `${route.label} main`)

            if (route.label === 'public-article') {
              await expect(session.page.locator('#fsus-comments-island')).toBeVisible()
            }

            await expectStableScreenshot(
              session.page,
              primary,
              `${route.label}-${viewport.name}-${theme}.png`,
              { maxDiffPixelRatio: 0.02 }
            )
          } finally {
            await session.close()
          }
        }
      })
    })
  }
}
