import { expect, test, type Browser, type Page } from '@playwright/test'

type ThemeMode = 'light' | 'dark'

const mobileViewport = { width: 390, height: 844 }
const menuSelector = '.el-public-shell__mobile-nav-menu'
const triggerSelector = '.el-public-shell__mobile-nav-menu-trigger'
const panelSelector = '.el-public-shell__mobile-nav-menu-panel'

async function openMobilePublicPage(
  browser: Browser,
  theme: ThemeMode,
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
) {
  const context = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000',
    viewport: mobileViewport,
    colorScheme: theme,
  })
  await context.addInitScript((selectedTheme) => {
    localStorage.setItem('fsus:theme-mode', selectedTheme)
    const apply = () => {
      const root = document.documentElement
      if (!root) return false
      root.classList.toggle('dark', selectedTheme === 'dark')
      root.classList.toggle('light', selectedTheme === 'light')
      root.dataset.themeMode = selectedTheme
      root.dataset.themeResolved = selectedTheme
      root.style.colorScheme = selectedTheme
      return true
    }
    if (!apply()) setTimeout(apply, 0)
  }, theme)
  const page = await context.newPage()
  const diagnostics: string[] = []
  page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return
    const text = message.text()
    if (/Failed to load resource|favicon|notification.*preflight/iu.test(text)) return
    diagnostics.push(`console:${message.type()}:${text}`)
  })
  await page.emulateMedia({ reducedMotion })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.readyState === 'complete' && Boolean(document.querySelector('#fsus-aot-shell')))
  await page.waitForTimeout(200)
  await expect(page.locator('#fsus-aot-shell')).toHaveAttribute(
    'data-public-hydration-kind',
    /Home|Archive|Filter|ArticleDetail|About/u,
  )
  return {
    page,
    assertClean: (label: string) => expect(diagnostics, `${label} runtime diagnostics`).toEqual([]),
    close: () => context.close(),
  }
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(dimensions.document, `${label} document overflow`).toBeLessThanOrEqual(dimensions.viewport + 1)
  expect(dimensions.body, `${label} body overflow`).toBeLessThanOrEqual(dimensions.viewport + 1)
}

async function motionCssState(page: Page, phase: 'enter' | 'leave') {
  return await page.locator(panelSelector).evaluate((panel, selectedPhase) => {
    const active = `el-public-shell-mobile-nav-menu-${selectedPhase}-active`
    const edge = selectedPhase === 'enter'
      ? 'el-public-shell-mobile-nav-menu-enter-from'
      : 'el-public-shell-mobile-nav-menu-leave-to'
    panel.classList.add(active)
    const activeStyle = getComputedStyle(panel)
    const transitionDuration = activeStyle.transitionDuration
    const transitionTimingFunction = activeStyle.transitionTimingFunction
    const previousInlineTransition = (panel as HTMLElement).style.transition
    ;(panel as HTMLElement).style.transition = 'none'
    panel.classList.add(edge)
    const edgeStyle = getComputedStyle(panel)
    const state = {
      opacity: edgeStyle.opacity,
      transform: edgeStyle.transform,
      transitionDuration,
      transitionTimingFunction,
    }
    panel.classList.remove(active, edge)
    ;(panel as HTMLElement).style.transition = previousInlineTransition
    return state
  }, phase)
}

function hasPositiveDuration(value: string): boolean {
  return value.split(',').some((part) => {
    const token = part.trim()
    if (token.endsWith('ms')) return Number.parseFloat(token) > 0
    if (token.endsWith('s')) return Number.parseFloat(token) > 0
    return false
  })
}

async function expectMenuClosed(page: Page) {
  await expect(page.locator(triggerSelector)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator(menuSelector)).not.toHaveAttribute('open', '')
  await expect(page.locator(panelSelector)).toBeHidden()
}

async function expectMenuOpen(page: Page) {
  await expect(page.locator(triggerSelector)).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator(menuSelector)).toHaveAttribute('open', '')
  await expect(page.locator(panelSelector)).toBeVisible()
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} consumer menu uses FsusUI enter/leave motion and preserves utility actions`, async ({ browser }) => {
    const session = await openMobilePublicPage(browser, theme)
    try {
      const { page } = session
      await expectMenuClosed(page)

      await page.locator(triggerSelector).click()
      await expectMenuOpen(page)

      const enter = await motionCssState(page, 'enter')
      const leave = await motionCssState(page, 'leave')
      expect(hasPositiveDuration(enter.transitionDuration)).toBe(true)
      expect(hasPositiveDuration(leave.transitionDuration)).toBe(true)
      expect(enter.opacity).toBe('0')
      expect(leave.opacity).toBe('0')
      expect(enter.transform).not.toBe('none')
      expect(leave.transform).not.toBe('none')
      expect(enter.transitionTimingFunction).not.toBe('ease')

      const themeButton = page.locator(`${panelSelector} .el-theme-mode-toggle__menu-button`)
      const authLink = page.locator(`${panelSelector} .el-public-shell__auth-link--mobile`)
      await expect(themeButton).toBeVisible()
      await expect(themeButton).toBeEnabled()
      await expect(authLink).toBeVisible()
      await expect(authLink).toHaveAttribute('href', /\/login$/u)
      await themeButton.click()
      const currentThemeOption = page.locator(
        `${panelSelector} .el-theme-mode-toggle__menu [data-theme-mode="${theme}"]`,
      )
      await expect(currentThemeOption).toBeVisible()
      await currentThemeOption.click()
      await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', theme)
      await assertNoHorizontalOverflow(page, `${theme} mobile menu open`)

      const closingState = await page.locator(triggerSelector).evaluate(async (trigger) => {
        ;(trigger as HTMLElement).click()
        await Promise.resolve()
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const details = trigger.closest('details')
        const panel = details?.querySelector<HTMLElement>('.el-public-shell__mobile-nav-menu-panel')
        return {
          detailsOpen: details?.open ?? false,
          expanded: trigger.getAttribute('aria-expanded'),
          closing: details?.classList.contains('is-closing') ?? false,
          inert: panel?.hasAttribute('inert') ?? false,
          ariaHidden: panel?.getAttribute('aria-hidden'),
        }
      })
      expect(closingState).toEqual({
        detailsOpen: true,
        expanded: 'false',
        closing: true,
        inert: true,
        ariaHidden: 'true',
      })
      await expectMenuClosed(page)
      session.assertClean(`${theme} public mobile menu motion`)
    } finally {
      await session.close()
    }
  })
}

test('SSR shell remains closed through hydration and reduced motion completes without waiting', async ({ browser, request }) => {
  const response = await request.get('/')
  expect(response.ok()).toBe(true)
  const html = await response.text()
  expect(html).toContain('el-public-shell__mobile-nav-menu')
  expect(html).toContain('el-public-shell__mobile-nav-menu-panel')

  const session = await openMobilePublicPage(browser, 'light', 'reduce')
  try {
    const { page } = session
    await expectMenuClosed(page)
    await page.locator(triggerSelector).click()
    await expectMenuOpen(page)

    for (const phase of ['enter', 'leave'] as const) {
      const state = await motionCssState(page, phase)
      expect(hasPositiveDuration(state.transitionDuration)).toBe(false)
      expect(state.transform).toBe('none')
    }

    await page.locator(triggerSelector).press('Escape')
    await expectMenuClosed(page)
    await expect(page.locator(triggerSelector)).toBeFocused()
    await assertNoHorizontalOverflow(page, 'reduced-motion mobile menu')
    session.assertClean('reduced-motion public mobile menu')
  } finally {
    await session.close()
  }
})

test('rapid reversal and every consumer close path converge on one accessible state', async ({ browser }) => {
  const session = await openMobilePublicPage(browser, 'dark')
  try {
    const { page } = session
    await page.locator(triggerSelector).evaluate(async (trigger) => {
      ;(trigger as HTMLElement).click()
      await Promise.resolve()
      ;(trigger as HTMLElement).click()
      await Promise.resolve()
      ;(trigger as HTMLElement).click()
    })
    await expectMenuOpen(page)
    await expect(page.locator(menuSelector)).not.toHaveClass(/\bis-closing\b/u)
    await assertNoHorizontalOverflow(page, 'rapidly reversed mobile menu')

    const navigationLink = page.locator(`${panelSelector} .el-public-shell__mobile-nav-link`).nth(1)
    await navigationLink.click()
    await page.waitForURL((url) => url.pathname === '/archive')
    await expect(page.locator(menuSelector)).toHaveCount(1)
    await expectMenuClosed(page)

    await page.locator(triggerSelector).click()
    await expectMenuOpen(page)
    await page.locator(triggerSelector).click()
    await expectMenuClosed(page)

    await page.locator(triggerSelector).click()
    await expectMenuOpen(page)
    await page.locator(triggerSelector).press('Escape')
    await expectMenuClosed(page)
    await expect(page.locator(triggerSelector)).toBeFocused()
    session.assertClean('mobile menu close paths')
  } finally {
    await session.close()
  }
})
