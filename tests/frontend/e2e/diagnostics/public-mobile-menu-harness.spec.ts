import { expect, test, type Browser, type Page } from '@playwright/test'

const mobileViewport = { width: 390, height: 844 }
const menuSelector = '.el-public-shell__mobile-nav-menu'
const triggerSelector = '.el-public-shell__mobile-nav-menu-trigger'
const panelSelector = '.el-public-shell__mobile-nav-menu-panel'

async function openHarness(browser: Browser, reducedMotion: 'reduce' | 'no-preference') {
  const context = await browser.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    viewport: mobileViewport,
  })
  const page = await context.newPage()
  const diagnostics: string[] = []
  page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push(`console:${message.type()}:${message.text()}`)
    }
  })
  await page.emulateMedia({ reducedMotion })
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.locator('html')).toHaveAttribute('data-fsusui-harness', 'ElPublicShell')
  await expect(page.locator('#harness-content')).toHaveText('isolated public-shell component')
  return {
    page,
    assertClean: () => expect(diagnostics, 'isolated FsusUI harness diagnostics').toEqual([]),
    close: () => context.close(),
  }
}

async function readMotionState(page: Page, phase: 'enter' | 'leave') {
  return await page.locator(panelSelector).evaluate((panel, selectedPhase) => {
    const active = `el-public-shell-mobile-nav-menu-${selectedPhase}-active`
    const edge = selectedPhase === 'enter'
      ? 'el-public-shell-mobile-nav-menu-enter-from'
      : 'el-public-shell-mobile-nav-menu-leave-to'
    panel.classList.add(active, edge)
    const style = getComputedStyle(panel)
    const state = {
      opacity: style.opacity,
      transform: style.transform,
      transitionDuration: style.transitionDuration,
      transitionProperty: style.transitionProperty,
      transitionTimingFunction: style.transitionTimingFunction,
    }
    panel.classList.remove(active, edge)
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

async function expectMenuOpen(page: Page) {
  await expect(page.locator(menuSelector)).toHaveAttribute('open', '')
  await expect(page.locator(triggerSelector)).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator(panelSelector)).toBeVisible()
}

async function expectMenuClosed(page: Page) {
  await expect(page.locator(menuSelector)).not.toHaveAttribute('open', '')
  await expect(page.locator(triggerSelector)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator(panelSelector)).toBeHidden()
}

test('local FsusUI component owns computed menu motion and Escape focus restoration', async ({ browser }) => {
  const session = await openHarness(browser, 'no-preference')
  try {
    const { page } = session
    await expectMenuClosed(page)
    await page.locator(triggerSelector).click()
    await expectMenuOpen(page)

    for (const phase of ['enter', 'leave'] as const) {
      const state = await readMotionState(page, phase)
      expect(hasPositiveDuration(state.transitionDuration)).toBe(true)
      expect(state.transitionProperty).toContain('opacity')
      expect(state.transitionProperty).toContain('transform')
      expect(state.transitionTimingFunction).not.toBe('ease')
      expect(state.opacity).toBe('0')
      expect(state.transform).not.toBe('none')
    }

    await page.locator(`${panelSelector} a`).first().focus()
    await page.keyboard.press('Escape')
    await expect(page.locator(triggerSelector)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(menuSelector)).toHaveClass(/\bis-closing\b/u)
    await expect(page.locator(panelSelector)).toHaveAttribute('aria-hidden', 'true')
    await expect(page.locator(panelSelector)).toHaveAttribute('inert', '')
    await expectMenuClosed(page)
    await expect(page.locator(triggerSelector)).toBeFocused()
    session.assertClean()
  } finally {
    await session.close()
  }
})

test('reduced motion removes displacement and completes the same focus contract', async ({ browser }) => {
  const session = await openHarness(browser, 'reduce')
  try {
    const { page } = session
    await page.locator(triggerSelector).click()
    await expectMenuOpen(page)

    for (const phase of ['enter', 'leave'] as const) {
      const state = await readMotionState(page, phase)
      expect(hasPositiveDuration(state.transitionDuration)).toBe(false)
      expect(state.transform).toBe('none')
    }

    await page.locator(`${panelSelector} a`).first().focus()
    await page.keyboard.press('Escape')
    await expectMenuClosed(page)
    await expect(page.locator(triggerSelector)).toBeFocused()
    session.assertClean()
  } finally {
    await session.close()
  }
})
