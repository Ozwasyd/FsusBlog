import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { fileURLToPath } from 'node:url'

type Theme = 'light' | 'dark'
type Auth = 'anonymous' | 'logged-in'
type FixtureState = 'empty' | 'populated' | 'closed' | 'loading' | 'error'

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/articleCommentRhythmVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`
const configuredPages = new WeakSet<Page>()

async function openFixture(
  page: Page,
  options: {
    state: FixtureState
    count: 0 | 1 | 5 | 41
    auth: Auth
    theme: Theme
  }
): Promise<void> {
  if (!configuredPages.has(page)) {
    await page.route('**/integrity/article/*/responsibility', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"static_fixture"}'
      })
    })
    await page.route('**/__article-comment-rhythm-fixture**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Article comment rhythm fixture</title></head>
          <body>
            <div id="article-comment-rhythm-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
      })
    })
    configuredPages.add(page)
  }

  const search = new URLSearchParams({
    state: options.state,
    count: String(options.count),
    auth: options.auth,
    theme: options.theme
  })
  await page.goto(`/__article-comment-rhythm-fixture?${search}`, {
    waitUntil: 'domcontentloaded'
  })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.articleCommentRhythmFixtureReady
  ))).toBe('true')
}

test.describe('article comment static rhythm fixture', () => {
  test.describe.configure({ timeout: 240_000 })

  test('expands root comments with the public control through keyboard input across themes and viewports', async ({ page }: { page: Page }, testInfo: TestInfo) => {
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await openFixture(page, { state: 'populated', count: 41, auth: 'anonymous', theme })

        const roots = page.locator('.fsus-comments-list > .fsus-comment-tree-node')
        const action = page.getByRole('button', { name: '显示更多评论（21）', exact: true })
        await expect(roots).toHaveCount(20)
        await expect(action).toHaveAttribute('type', 'button')

        await roots.last().getByRole('button', { name: '登录后回复', exact: true }).focus()
        await page.keyboard.press('Tab')
        await expect(action).toBeFocused()
        expect(await action.evaluate((element: HTMLElement) => element.matches(':focus-visible'))).toBe(true)
        expect(await action.evaluate((element: HTMLElement) => {
          const style = getComputedStyle(element)
          return style.boxShadow !== 'none' || style.outlineStyle !== 'none'
        })).toBe(true)
        await page.evaluate(async () => { await document.fonts.ready })
        await action.screenshot({ path: testInfo.outputPath(`expansion-focus-${theme}-${width}.png`) })

        await page.keyboard.press('Enter')
        await expect(roots).toHaveCount(40)
        const finalAction = page.getByRole('button', { name: '显示更多评论（1）', exact: true })
        await expect(finalAction).toBeFocused()
        await page.keyboard.press('Space')
        await expect(roots).toHaveCount(41)
        await expect(page.locator('.fsus-comments-list__more')).toHaveCount(0)
        expect(await roots.evaluateAll((elements: Element[]) => elements.map(element => element.id)))
          .toEqual(Array.from({ length: 41 }, (_, index) => `comment-${146_400 + index}`))
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
          .toBeLessThanOrEqual(1)
      }
    }
  })

  test('covers the seven-state content-driven geometry matrix without a backend', async ({ page }) => {
    const cases = [
      { name: 'empty-anonymous-mobile', state: 'empty', count: 0, auth: 'anonymous', theme: 'light', width: 375, height: 667 },
      { name: 'empty-logged-in-mobile', state: 'empty', count: 0, auth: 'logged-in', theme: 'dark', width: 375, height: 812 },
      { name: 'one-anonymous-mobile', state: 'populated', count: 1, auth: 'anonymous', theme: 'light', width: 375, height: 812 },
      { name: 'five-logged-in-mobile', state: 'populated', count: 5, auth: 'logged-in', theme: 'dark', width: 390, height: 844 },
      { name: 'closed-tablet', state: 'closed', count: 0, auth: 'anonymous', theme: 'light', width: 768, height: 900 },
      { name: 'loading-desktop', state: 'loading', count: 0, auth: 'logged-in', theme: 'dark', width: 1440, height: 900 },
      { name: 'error-mobile', state: 'error', count: 0, auth: 'anonymous', theme: 'light', width: 375, height: 812 }
    ] as const
    const sharedMobileHeaderLeft = new Map<string, number>()

    for (const fixtureCase of cases) {
      await page.setViewportSize({
        width: fixtureCase.width,
        height: fixtureCase.height
      })
      await openFixture(page, fixtureCase)
      await expect(page.locator('#fsus-comments-island')).toBeVisible()
      await expect(page.locator('.el-public-shell__footer')).toBeVisible()
      expect(await page.evaluate(() => ({
        state: document.documentElement.dataset.fixtureState,
        count: document.documentElement.dataset.fixtureCount,
        auth: document.documentElement.dataset.fixtureAuth,
        theme: document.documentElement.dataset.fixtureTheme
      }))).toEqual({
        state: fixtureCase.state,
        count: String(fixtureCase.count),
        auth: fixtureCase.auth,
        theme: fixtureCase.theme
      })

      const geometry = await page.evaluate(() => {
        const article = document.querySelector<HTMLElement>('.public-article-detail')!
        const bodyElement = document.querySelector<HTMLElement>('.article-comment-rhythm-fixture__body')!
        const section = document.querySelector<HTMLElement>('#fsus-comments-island')!
        const headingElement = document.querySelector<HTMLElement>('#comments')!
        const stateContainer = document.querySelector<HTMLElement>('#fsus-comments-island-content')!
        const footerElement = document.querySelector<HTMLElement>('.el-public-shell__footer')!
        const bodyBox = bodyElement.getBoundingClientRect()
        const sectionBox = section.getBoundingClientRect()
        const headingBox = headingElement.getBoundingClientRect()
        const stateBox = stateContainer.getBoundingClientRect()
        const headingStyle = getComputedStyle(headingElement)
        const footerBox = footerElement.getBoundingClientRect()
        return {
          articleMinHeight: Number.parseFloat(getComputedStyle(article).minHeight),
          bodyToSection: sectionBox.top - bodyBox.bottom,
          headingPaddingBottom: Number.parseFloat(headingStyle.paddingBottom),
          dividerToState: stateBox.top - headingBox.bottom,
          contentToFooter: footerBox.top - stateBox.bottom,
          headerLeft: headingBox.left,
          sectionLeft: sectionBox.left,
          overflow: document.documentElement.scrollWidth - window.innerWidth
        }
      })

      expect(geometry.articleMinHeight, fixtureCase.name).toBe(0)
      expect(geometry.bodyToSection, fixtureCase.name)
        .toBeGreaterThanOrEqual(fixtureCase.width < 640 ? 40 : 56)
      expect(geometry.bodyToSection, fixtureCase.name)
        .toBeLessThanOrEqual(fixtureCase.width < 640 ? 48 : 64)
      expect(geometry.headingPaddingBottom, fixtureCase.name).toBe(12)
      expect(geometry.dividerToState, fixtureCase.name).toBe(24)
      expect(geometry.contentToFooter, fixtureCase.name).toBeGreaterThanOrEqual(48)
      expect(geometry.contentToFooter, fixtureCase.name).toBeLessThanOrEqual(64)
      expect(geometry.headerLeft, fixtureCase.name).toBe(geometry.sectionLeft)
      expect(geometry.overflow, fixtureCase.name).toBeLessThanOrEqual(1)

      if (fixtureCase.state === 'empty' && fixtureCase.auth === 'anonymous') {
        const cta = page.locator('.fsus-comments-empty__btn')
        await expect(cta).toBeVisible()
        const ctaGeometry = await cta.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          const footer = document.querySelector<HTMLElement>('.el-public-shell__footer')!
          return {
            height: box.height,
            radius: Number.parseFloat(style.borderRadius),
            paddingInline: Number.parseFloat(style.paddingInlineStart),
            footerGap: footer.getBoundingClientRect().top - box.bottom
          }
        })
        expect(ctaGeometry.height).toBe(44)
        expect(ctaGeometry.radius).toBe(6)
        expect(ctaGeometry.paddingInline).toBe(16)
        expect(ctaGeometry.footerGap).toBeGreaterThanOrEqual(48)
        expect(ctaGeometry.footerGap).toBeLessThanOrEqual(64)
        await cta.focus()
        await expect(cta).toBeFocused()
        expect(await cta.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none')
      }

      if (fixtureCase.width === 375 && fixtureCase.height === 812) {
        const geometryKey = `${fixtureCase.width}x${fixtureCase.height}`
        const previousHeaderLeft = sharedMobileHeaderLeft.get(geometryKey)
        if (previousHeaderLeft === undefined) {
          sharedMobileHeaderLeft.set(geometryKey, geometry.headerLeft)
        } else {
          expect(geometry.headerLeft, fixtureCase.name).toBe(previousHeaderLeft)
        }
      }
    }
  })
})
