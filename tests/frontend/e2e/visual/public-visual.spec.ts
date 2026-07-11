import { test, expect, type Page } from '@playwright/test'
import {
  UX_VIEWPORT_MATRIX,
  WARMUP_TIMEOUT_MS,
  type ThemeMode,
  assertElementInViewport,
  assertNoHorizontalOverflow,
  assertThemeReadable,
  expectStableScreenshot,
  openThemedAuditedPage,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

const articlePath = `/article/${process.env.FSUSBLOG_VISUAL_ARTICLE_ID || '1'}`

const viewports = UX_VIEWPORT_MATRIX.viewports
  .filter((viewport) => viewport.useInPublicVisual)
  .map((viewport) => ({
    name: viewport.name,
    size: { width: viewport.width, height: viewport.height },
    screenshot: viewport.name === 'desktop' || viewport.name === 'mobile'
  }))

const themes: ThemeMode[] = ['light', 'dark']

const routes = [
  { path: '/', label: 'public-home', primary: 'main header', screenshot: true },
  { path: '/archive', label: 'public-archive', primary: 'main', screenshot: false },
  { path: articlePath, label: 'public-article', primary: 'main', screenshot: true },
  { path: '/about', label: 'public-static-about', primary: 'main', screenshot: false },
  { path: '/login', label: 'public-login', primary: 'main', screenshot: true }
] as const

async function assertHomeEditorialContract(page: Page): Promise<void> {
  const lead = page.locator('[data-home-editorial-lead]')
  expect(await lead.count()).toBeLessThanOrEqual(1)

  if (await lead.count() === 1) {
    const layout = await lead.getAttribute('data-home-lead-layout')
    expect(['media', 'text']).toContain(layout)
    await expect(lead.locator('h1')).toBeVisible()
    if (layout === 'media') {
      await expect(lead.locator('img')).toHaveCount(1)
    } else {
      await expect(lead.locator('img')).toHaveCount(0)
    }
  }

  const articleIds = await page.locator('#fsus-home-main-column [data-article-id]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-article-id')).filter((id): id is string => Boolean(id))
  )
  expect(new Set(articleIds).size).toBe(articleIds.length)

  const ordinaryArticleEntryCounts = await page
    .locator('#fsus-home-main-column article:has(a[data-public-link="article"])')
    .evaluateAll((articles) => articles.map((article) => article.querySelectorAll('a[data-public-link="article"]').length))
  expect(ordinaryArticleEntryCounts.every((count) => count === 1)).toBe(true)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('#fsus-home-main-column')).toBeVisible()
  const reducedMotionArticleIds = await page.locator('#fsus-home-main-column [data-article-id]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-article-id')).filter((id): id is string => Boolean(id))
  )
  expect(reducedMotionArticleIds).toEqual(articleIds)
}

async function assertPublicCoverRendering(page: Page, label: string): Promise<void> {
  const covers = page.locator('[data-content-cover]')
  expect(await covers.count(), `${label} should render at most one cover`).toBeLessThanOrEqual(1)
  if (await covers.count() === 0) {
    return
  }

  const cover = covers.first()
  const image = cover.locator('img')
  await expect(image).toBeVisible()
  await expect(cover).toHaveAttribute('data-cover-safe-area', 'center-80')
  const presentation = await cover.evaluate((element) => {
    const imageElement = element.querySelector('img')
    if (!(imageElement instanceof HTMLImageElement)) return null
    const containerStyle = getComputedStyle(element)
    const imageStyle = getComputedStyle(imageElement)
    return {
      objectFit: imageStyle.objectFit,
      objectPosition: imageStyle.objectPosition,
      filter: imageStyle.filter,
      backgroundImage: containerStyle.backgroundImage,
      shadowNone: element.classList.contains('shadow-none'),
      borderWidth: Number.parseFloat(containerStyle.borderTopWidth)
    }
  })
  expect(presentation).toEqual({
    objectFit: 'cover',
    objectPosition: '50% 50%',
    filter: 'none',
    backgroundImage: 'none',
    shadowNone: true,
    borderWidth: 1
  })
}

async function assertEditorialPublicChrome(page: Page, viewportWidth: number): Promise<void> {
  const shell = page.locator('#fsus-aot-shell > .el-public-shell')
  await expect(shell).toHaveCount(1)
  await expect(shell).toHaveAttribute('data-mobile-nav-mode', 'menu')
  await expect(shell).toHaveAttribute('data-public-mobile-nav-mode', 'menu')
  await expect(shell.locator('[data-public-shell-header]')).toHaveCount(1)
  await expect(page.locator('[data-fsus-bottom-tab-bar]')).toHaveCount(0)
  await expect(page.locator('.el-public-shell__bottom-tab')).toHaveCount(0)
  await expect(page.locator('.fsusblog-public-bottom-tab')).toHaveCount(0)

  const colophon = page.locator('.public-colophon')
  await expect(colophon).toHaveCount(1)
  await expect(colophon.locator('.public-colophon__primary')).toHaveCount(1)
  await expect(colophon.locator('.public-colophon__secondary')).toHaveCount(1)
  await expect(colophon.locator('.public-colophon__primary a[href="/feed/rss.xml"]')).toHaveCount(1)

  if (viewportWidth >= 768) {
    const search = page.locator('.public-chrome-search--desktop')
    const trigger = search.locator('.public-chrome-search__trigger')
    await expect(trigger).toHaveAttribute('href', '/search')
    await expect(trigger).toHaveAttribute('aria-label', /搜索/u)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(search.locator('input')).toHaveCount(0)
    await expect(page.locator('.el-theme-mode-toggle--desktop .el-theme-mode-toggle__menu-button')).toBeVisible()

    await trigger.click()
    const input = search.locator('input').first()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
    await input.press('Escape')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(trigger).toBeFocused()
    return
  }

  const primaryActions = shell.locator('.el-public-shell__mobile-primary-actions')
  const searchTrigger = primaryActions.locator('.el-public-shell__mobile-search-trigger')
  const mobileToolbar = shell.locator('.el-public-shell__mobile-toolbar')
  const mobileSearchRow = shell.locator('.el-public-shell__mobile-search-row')
  const menu = primaryActions.locator('.el-public-shell__mobile-nav-menu')
  const menuTrigger = menu.locator('.el-public-shell__mobile-nav-menu-trigger')
  const menuPanel = menu.locator('.el-public-shell__mobile-nav-menu-panel')
  const mobileTheme = menuPanel.locator('.el-theme-mode-toggle--mobile .el-theme-mode-toggle__menu-button')
  const mobileAuth = menuPanel.locator('.el-public-shell__auth-link--mobile')

  await expect(primaryActions).toBeVisible()
  await expect(searchTrigger).toHaveCount(1)
  await expect(searchTrigger).toHaveAttribute('href', '/search')
  await expect(searchTrigger).toHaveAttribute('aria-label', /搜索/u)
  await expect(searchTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(mobileToolbar).toHaveClass(/\bis-collapsed\b/u)
  await expect(mobileToolbar).toBeHidden()
  await expect(mobileSearchRow).toBeHidden()
  await expect(page.locator('.public-mobile-nav-menu')).toHaveCount(0)
  await expect(menu).toHaveCount(1)
  await expect(menuPanel).toHaveCount(1)
  await expect(menuPanel.locator('.el-public-shell__mobile-nav-link')).toHaveCount(3)
  await expect(menuPanel.locator('.el-theme-mode-toggle')).toHaveCount(1)
  await expect(menuPanel.locator('.el-public-shell__auth-link')).toHaveCount(1)
  await expect(menuTrigger).toHaveAttribute('aria-expanded', 'false')
  await menuTrigger.click()
  await expect(menuTrigger).toHaveAttribute('aria-expanded', 'true')
  await expect(menuPanel).toBeVisible()
  await expect(mobileTheme).toBeVisible()
  await expect(mobileAuth).toBeVisible()
  await expect(menuPanel.locator('.el-public-shell__mobile-nav-link[aria-current="page"]')).toHaveCount(1)
  await menuTrigger.press('Escape')
  await expect(menuTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(menuTrigger).toBeFocused()

  await searchTrigger.click()
  const mobileSearchInput = mobileSearchRow.locator('input.el-input__inner')
  await expect(searchTrigger).toHaveAttribute('aria-expanded', 'true')
  await expect(mobileToolbar).not.toHaveClass(/\bis-collapsed\b/u)
  await expect(mobileSearchRow).toBeVisible()
  await expect(mobileSearchInput).toBeVisible()
  await expect(mobileSearchInput).toBeFocused()
  await mobileSearchInput.press('Escape')
  await expect(searchTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(searchTrigger).toBeFocused()
  await expect(mobileToolbar).toHaveClass(/\bis-collapsed\b/u)
  await expect(mobileToolbar).toBeHidden()
}

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
              await assertPublicCoverRendering(session.page, `${route.label} ${viewport.name} ${theme}`)
            }

            if (route.label === 'public-home') {
              await assertEditorialPublicChrome(session.page, viewport.size.width)
              await assertHomeEditorialContract(session.page)
              await assertPublicCoverRendering(session.page, `${route.label} ${viewport.name} ${theme}`)
            }

            if (viewport.screenshot && route.screenshot) {
              await expectStableScreenshot(
                session.page,
                primary,
                `${route.label}-${viewport.name}-${theme}.png`,
                { maxDiffPixelRatio: 0.02 }
              )
            }
          } finally {
            await session.close()
          }
        }
      })
    })
  }
}
