import { test, expect, type Page } from '@playwright/test'
import {
  UX_VIEWPORT_MATRIX,
  WARMUP_TIMEOUT_MS,
  type ThemeMode,
  applyUxViewportMediaMode,
  assertElementInViewport,
  assertFocusOutlineVisible,
  assertNoHorizontalOverflow,
  assertThemeReadable,
  assertTouchTargetSize,
  assertUxViewportMediaMode,
  expectStableScreenshot,
  openThemedAuditedPage,
  resetUxViewportMediaMode,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import {
  PUBLIC_LAYOUT_ARCHETYPES,
  resolveLayoutArchetypePath
} from '../../support/playwright/layoutArchetypeMatrix'

const archetypeFixtures = {
  articleId: process.env.FSUSBLOG_VISUAL_ARTICLE_ID || '1',
  searchKeyword: process.env.FSUSBLOG_VISUAL_SEARCH_KEYWORD || 'test'
}
const routes = PUBLIC_LAYOUT_ARCHETYPES.map((archetype) => ({
  ...archetype,
  path: resolveLayoutArchetypePath(archetype, archetypeFixtures)
}))
const articlePath = routes.find((route) => route.kind === 'reading')?.path
  ?? `/article/${archetypeFixtures.articleId}`

const viewports = UX_VIEWPORT_MATRIX.viewports
  .filter((viewport) => viewport.useInPublicVisual)
  .map((viewport) => ({
    name: viewport.name,
    size: { width: viewport.width, height: viewport.height },
    screenshot: viewport.name === 'desktop' || viewport.name === 'mobile'
  }))

const themes: ThemeMode[] = ['light', 'dark']

const semanticColors = {
  light: {
    primary: 'rgb(15, 15, 17)',
    tertiary: 'rgb(113, 113, 122)',
    quiet: 'rgb(161, 161, 170)',
    border: 'rgb(228, 228, 231)',
    accent: 'rgb(42, 89, 156)',
    raised: 'rgb(247, 247, 248)'
  },
  dark: {
    primary: 'rgb(240, 240, 244)',
    tertiary: 'rgb(161, 161, 170)',
    quiet: 'rgb(161, 161, 170)',
    border: 'rgb(39, 39, 42)',
    accent: 'rgb(75, 121, 204)',
    raised: 'rgb(26, 26, 30)'
  }
} as const

async function assertArchetypeAccessibility(page: Page, label: string): Promise<void> {
  await assertFocusOutlineVisible(page, label)
  await assertTouchTargetSize(page, label)
  for (const media of ['reduced-motion', 'high-contrast'] as const) {
    await resetUxViewportMediaMode(page)
    await applyUxViewportMediaMode(page, media)
    await assertUxViewportMediaMode(page, media, `${label} ${media}`)
    await assertNoHorizontalOverflow(page, 8)
  }
  await resetUxViewportMediaMode(page)
}

async function assertArticleSemanticColors(page: Page, theme: ThemeMode): Promise<void> {
  const expected = semanticColors[theme]
  const targets = [
    ['[data-article-rights-notice]', expected.tertiary],
    ['.fsus-appendix__meta', expected.quiet],
    ['.fsus-appendix__link', expected.primary],
    ['.fsus-comment', expected.primary],
    ['.fsus-comment__time', expected.quiet],
    ['.comment-markdown-renderer', expected.primary],
    ['.fsus-comments-empty__text', expected.quiet]
  ] as const

  for (const [selector, color] of targets) {
    const target = page.locator(selector).first()
    if (await target.count()) {
      await expect(target).toHaveCSS('color', color)
    }
  }

  const inlineCode = page.locator('.comment-markdown-renderer code:not(pre code)').first()
  if (await inlineCode.count()) {
    await expect(inlineCode).toHaveCSS('background-color', expected.raised)
  }

  const comment = page.locator('.fsus-comment').first()
  if (await comment.count()) {
    await expect(comment).toHaveCSS('border-bottom-color', expected.border)
  }

  const interactive = page.locator('.fsus-appendix__link, .fsus-comment__action, .fsus-comments-empty__btn').first()
  if (await interactive.count()) {
    await interactive.hover()
    await expect(interactive).toHaveCSS('color', expected.accent)
    await interactive.focus()
    await expect(interactive).toHaveCSS('outline-color', expected.accent)
  }
}

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

  const recommendationIds = await page.locator(
    '#fsus-home-main-column [data-home-editorial-lead][data-article-id], #fsus-home-main-column [data-home-editorial-secondary] [data-article-id]'
  ).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-article-id')).filter((id): id is string => Boolean(id))
  )
  expect(new Set(recommendationIds).size).toBe(recommendationIds.length)

  const feedIds = await page.locator(
    '#fsus-home-main-column [data-home-feed-section] [data-article-id]'
  ).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-article-id')).filter((id): id is string => Boolean(id))
  )
  expect(new Set(feedIds).size).toBe(feedIds.length)

  const ordinaryArticleEntryCounts = await page
    .locator('#fsus-home-main-column article:has(a[data-public-link="article"])')
    .evaluateAll((articles) => articles.map((article) => article.querySelectorAll('a[data-public-link="article"]').length))
  expect(ordinaryArticleEntryCounts.every((count) => count === 1)).toBe(true)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('#fsus-home-main-column')).toBeVisible()
  const reducedMotionFeedIds = await page.locator(
    '#fsus-home-main-column [data-home-feed-section] [data-article-id]'
  ).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-article-id')).filter((id): id is string => Boolean(id))
  )
  expect(reducedMotionFeedIds).toEqual(feedIds)
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
              await assertArticleSemanticColors(session.page, theme)
            }

            if (route.label === 'public-home') {
              await assertEditorialPublicChrome(session.page, viewport.size.width)
              await assertHomeEditorialContract(session.page)
              await assertPublicCoverRendering(session.page, `${route.label} ${viewport.name} ${theme}`)
            }

            await assertArchetypeAccessibility(session.page, `${route.label} ${viewport.name} ${theme}`)

            if (viewport.screenshot && route.snapshot) {
              const screenshotTarget = session.page.locator(route.screenshotTarget).first()
              await expectStableScreenshot(
                session.page,
                screenshotTarget,
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

test.describe('article semantic theme tokens', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  for (const scenario of [
    { name: 'light', initial: 'light', expected: 'light', systemDark: false },
    { name: 'explicit dark', initial: 'dark', expected: 'dark', systemDark: false },
    { name: 'system-resolved dark', initial: 'light', expected: 'dark', systemDark: true }
  ] as const) {
    test(`${scenario.name} resolves article colors from the same semantic boundary`, async ({ browser }) => {
      const session = await openThemedAuditedPage(browser, scenario.initial)

      try {
        await session.page.goto(articlePath, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)

        if (scenario.systemDark) {
          await session.page.emulateMedia({ colorScheme: 'dark' })
          await session.page.evaluate(() => {
            const root = document.documentElement
            localStorage.setItem('fsus:theme-mode', 'system')
            root.classList.remove('light', 'dark')
            root.dataset.themeMode = 'system'
            root.dataset.themeResolved = 'dark'
          })
        }

        await settlePage(session.page)
        await expect(session.page.locator('#fsus-comments-island')).toBeVisible()
        await expect(session.page.locator('.fsus-appendix__link').first()).toBeVisible()
        await assertArticleSemanticColors(session.page, scenario.expected)
      } finally {
        await session.close()
      }
    })
  }
})
