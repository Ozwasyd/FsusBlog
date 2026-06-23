#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { encodeAdminPrincipalSnapshotFrame, encodeIdentityAccountSnapshotFrame } from '../../support/aeds-envelope.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))

const baseUrl =
  process.env.PLAYWRIGHT_BASE_URL
  || process.env.FSUSBLOG_PUBLIC_BASE_URL
  || process.env.FSUSBLOG_BASE_URL
  || 'http://127.0.0.1:3000'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((candidate) => existsSync(candidate))

const widths = [320, 375, 390, 430, 594, 768, 1024, 1280, 1440]
const routes = ['/', '/archive', '/about', '/search?q=test']
const themeScenarios = [
  { name: 'light', storageMode: 'light', colorScheme: 'light', expectedResolved: 'light', menuText: '浅', menuAria: '主题模式: 浅色' },
  { name: 'dark', storageMode: 'dark', colorScheme: 'dark', expectedResolved: 'dark', menuText: '深', menuAria: '主题模式: 深色' },
  { name: 'system-light', storageMode: 'system', colorScheme: 'light', expectedResolved: 'light', menuText: '系统', menuAria: '主题模式: 跟随系统' },
  { name: 'system-dark', storageMode: 'system', colorScheme: 'dark', expectedResolved: 'dark', menuText: '系统', menuAria: '主题模式: 跟随系统' },
]
const authModes = [
  { name: 'logged-out', response: 'unauthorized', expectedAuthText: '登录', expectedAuthHref: '/login' },
  { name: 'admin', response: 'admin', expectedAuthText: '控制板', expectedAuthHref: '/user/manage' },
]
const fullMatrix = process.env.FSUSBLOG_PUBLIC_HEADER_FULL_MATRIX === '1'
const verbose = process.env.FSUSBLOG_PUBLIC_HEADER_VERBOSE === '1'
const activeWidths = fullMatrix ? widths : [320, 768, 1440]
const activeRoutes = fullMatrix ? routes : ['/', '/search?q=test']
const activeThemeScenarios = themeScenarios
const activeAuthModes = authModes

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function assertNear(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`)
  }
}

function assertBoxMetric(box, metric, expected, label) {
  assert(box && typeof box[metric] === 'number', `${label}: missing ${metric}`)
  assertNear(box[metric], expected, 1, `${label}: ${metric}`)
}

function normalizeCssValue(value) {
  return String(value || '').trim().toLowerCase()
}

function isTransparent(value) {
  const normalized = normalizeCssValue(value)
  return normalized === 'transparent'
    || normalized === 'rgba(0, 0, 0, 0)'
    || normalized === 'rgba(0,0,0,0)'
}

async function installAuthFixture(context, authMode) {
  await context.route('**/api/binary/auth/me', async (requestRoute) => {
    if (authMode.response === 'admin') {
      await requestRoute.fulfill({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from(encodeIdentityAccountSnapshotFrame({
          accountId: 1,
          publicHandle: 'header-user',
          identityKind: 'anonymous_account',
          status: 0,
        })),
      })
      return
    }

    await requestRoute.fulfill({
      status: 401,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    })
  })

  await context.route('**/api/binary/auth/admin/me', async (requestRoute) => {
    if (authMode.response === 'admin') {
      await requestRoute.fulfill({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from(encodeAdminPrincipalSnapshotFrame()),
      })
      return
    }

    await requestRoute.fulfill({
      status: 401,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    })
  })
}

async function inspectHeader(page, width, route, theme, authMode) {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForSelector('.el-public-shell', { timeout: 10000 })
  await page.waitForFunction(() => {
    const shell = document.querySelector('#fsus-aot-shell')
    return Boolean(shell && (!shell.getAttribute('data-public-hydration-kind') || shell.dataset.publicHydrated === 'true'))
  }, undefined, { timeout: 10000 })
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
  })
  if (authMode.response === 'admin') {
    await page.waitForFunction(
      (expected) => document.querySelector('.el-public-shell__auth-link')?.textContent?.trim() === expected,
      authMode.expectedAuthText,
      { timeout: 6000 }
    )
  }
  await page.waitForFunction(
    (expected) => {
      const menuButton = document.querySelector('.el-theme-mode-toggle__menu-button')
      return menuButton?.textContent?.trim() === expected.menuText
        && menuButton?.getAttribute('aria-label') === expected.menuAria
    },
    { menuText: theme.menuText, menuAria: theme.menuAria },
    { timeout: 6000 }
  )

  const state = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement)
    const header = document.querySelector('.el-public-shell__header')
    const shell = document.querySelector('.el-public-shell')
    const primaryActions = document.querySelector('.el-public-shell__mobile-primary-actions')
    const mobileToolbar = document.querySelector('.el-public-shell__mobile-toolbar')
    const mobileSearchRow = document.querySelector('.el-public-shell__mobile-search-row')
    const trigger = document.querySelector('.el-public-shell__mobile-search-trigger')
    const menuButton = document.querySelector('.el-theme-mode-toggle__menu-button')
    const desktopActions = document.querySelector('.el-public-shell__actions')
    const desktopNav = document.querySelector('.el-public-shell__desktop-nav')
    const desktopSearch = document.querySelector('.el-public-shell__search--desktop')
    const authLink = document.querySelector('.el-public-shell__auth-link')
    const headerStyle = header ? getComputedStyle(header) : null
    const getDisplay = (element) => element ? getComputedStyle(element).display : null
    const getWidth = (element) => element ? Number.parseFloat(getComputedStyle(element).width) : null
    const getBox = (element) => {
      if (!element) {
        return null
      }
      const box = element.getBoundingClientRect()
      return {
        height: Number(box.height.toFixed(2)),
        centerY: Number((box.top + box.height / 2).toFixed(2)),
      }
    }

    return {
      resolvedTheme: document.documentElement.dataset.themeResolved || '',
      themeMode: document.documentElement.dataset.themeMode || '',
      pageToken: rootStyle.getPropertyValue('--fsus-page'),
      paperToken: rootStyle.getPropertyValue('--fsus-paper'),
      inkToken: rootStyle.getPropertyValue('--fsus-ink'),
      headerBgToken: rootStyle.getPropertyValue('--fsusblog-header-bg'),
      headerBorderToken: rootStyle.getPropertyValue('--fsusblog-header-border'),
      elBgToken: rootStyle.getPropertyValue('--el-bg-color'),
      elPageToken: rootStyle.getPropertyValue('--el-bg-color-page'),
      elBorderToken: rootStyle.getPropertyValue('--el-border-color-lighter'),
      blurToken: rootStyle.getPropertyValue('--fsusblog-backdrop-blur-soft'),
      saturateToken: rootStyle.getPropertyValue('--fsusblog-backdrop-saturate'),
      hasShell: Boolean(shell),
      headerBackground: headerStyle?.backgroundColor ?? '',
      headerBackgroundImage: headerStyle?.backgroundImage ?? '',
      headerBorderBottomColor: headerStyle?.borderBottomColor ?? '',
      headerBoxShadow: headerStyle?.boxShadow ?? '',
      headerBackdropFilter: headerStyle?.backdropFilter ?? headerStyle?.webkitBackdropFilter ?? '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      primaryActionsDisplay: getDisplay(primaryActions),
      mobileToolbarDisplay: getDisplay(mobileToolbar),
      mobileSearchRowDisplay: getDisplay(mobileSearchRow),
      triggerText: trigger?.textContent?.trim() ?? '',
      triggerExpanded: trigger?.getAttribute('aria-expanded') ?? '',
      menuText: menuButton?.textContent?.trim() ?? '',
      menuAria: menuButton?.getAttribute('aria-label') ?? '',
      desktopActionsDisplay: getDisplay(desktopActions),
      desktopNavDisplay: getDisplay(desktopNav),
      desktopSearchWidth: getWidth(desktopSearch),
      innerBox: getBox(document.querySelector('.el-public-shell__inner')),
      primaryBox: getBox(document.querySelector('.el-public-shell__primary-row')),
      brandBox: getBox(document.querySelector('.el-public-shell__brand')),
      desktopNavLinkBox: getBox(document.querySelector('.el-public-shell__desktop-nav .el-public-shell__nav-link')),
      desktopSearchBox: getBox(desktopSearch),
      desktopThemeBox: getBox(document.querySelector('.el-theme-mode-toggle--desktop')),
      desktopAuthBox: getBox(document.querySelector('.el-public-shell__actions .el-public-shell__auth-link')),
      mobileSearchBox: getBox(trigger),
      mobileThemeBox: getBox(document.querySelector('.el-theme-mode-toggle--mobile .el-theme-mode-toggle__menu-button')),
      mobileAuthBox: getBox(document.querySelector('.el-public-shell__auth-link--mobile')),
      authText: authLink?.textContent?.trim() ?? '',
      authHref: authLink?.getAttribute('href') ?? '',
      oldMobileTheme: Boolean(document.querySelector('.el-public-shell__mobile-actions .el-theme-mode-toggle')),
      oldMobileSearch: Boolean(document.querySelector('.el-public-shell__search--mobile')),
      gradientOrDecor: [...document.querySelectorAll('.el-public-shell, .el-public-shell *')]
        .some((node) => {
          const style = getComputedStyle(node)
          return /linear-gradient|radial-gradient|conic-gradient/i.test(style.backgroundImage)
        }),
    }
  })

  const label = `${theme.name} ${authMode.name} ${width} ${route}`
  assert(state.hasShell, `${label}: missing public shell`)
  assert(state.resolvedTheme === theme.expectedResolved, `${label}: resolved theme ${state.resolvedTheme}`)
  assert(normalizeCssValue(state.blurToken) === '0px', `${label}: blur token ${state.blurToken}`)
  assert(normalizeCssValue(state.saturateToken) === '100%', `${label}: saturate token ${state.saturateToken}`)
  assert(normalizeCssValue(state.elBgToken) === normalizeCssValue(state.headerBgToken), `${label}: el bg token ${state.elBgToken}`)
  assert(normalizeCssValue(state.elPageToken) === normalizeCssValue(state.pageToken), `${label}: el page token ${state.elPageToken}`)
  assert(normalizeCssValue(state.elBorderToken) === normalizeCssValue(state.headerBorderToken), `${label}: el border token ${state.elBorderToken}`)
  assert(!isTransparent(state.headerBackground), `${label}: header background is transparent`)
  assert(state.headerBackgroundImage === 'none', `${label}: header background image ${state.headerBackgroundImage}`)
  assert(!isTransparent(state.headerBorderBottomColor), `${label}: header border is transparent`)
  assert(state.headerBoxShadow === 'none', `${label}: header box shadow ${state.headerBoxShadow}`)
  assert(/blur\(0(px)?\)/i.test(state.headerBackdropFilter) || state.headerBackdropFilter === 'none', `${label}: header backdrop ${state.headerBackdropFilter}`)
  assert(!state.gradientOrDecor, `${label}: decorative gradient detected inside public shell`)
  assert(!state.oldMobileTheme, `${label}: mobile theme uses old actions slot`)
  assert(!state.oldMobileSearch, `${label}: legacy mobile search exists`)
  assert(state.authText === authMode.expectedAuthText, `${label}: auth text ${state.authText}`)
  assert(state.authHref === authMode.expectedAuthHref, `${label}: auth href ${state.authHref}`)
  assert(state.overflow <= 1, `${label}: horizontal overflow ${state.overflow}`)

  if (width < 768) {
    const searchRoute = route.startsWith('/search')
    const initiallyExpanded = state.triggerExpanded === 'true'
    assert(state.primaryActionsDisplay !== 'none', `${label}: mobile primary actions hidden`)
    assert(state.desktopActionsDisplay === 'none', `${label}: desktop actions visible on mobile`)
    assert(state.desktopNavDisplay === 'none', `${label}: desktop nav visible on mobile`)
    for (const [boxLabel, box] of [
      ['brand', state.brandBox],
      ['mobile search', state.mobileSearchBox],
      ['mobile theme', state.mobileThemeBox],
      ['mobile auth', state.mobileAuthBox],
    ]) {
      assertBoxMetric(box, 'height', 40, `${label}: ${boxLabel}`)
      assertBoxMetric(
        { centerY: Math.abs(box.centerY - state.primaryBox.centerY) },
        'centerY',
        0,
        `${label}: ${boxLabel} center delta`,
      )
    }
    if (searchRoute) {
      assert(['搜索', '取消'].includes(state.triggerText), `${label}: trigger text ${state.triggerText}`)
      assert(['false', 'true'].includes(state.triggerExpanded), `${label}: trigger expanded ${state.triggerExpanded}`)
      if (initiallyExpanded) {
        assert(state.mobileToolbarDisplay !== 'none', `${label}: search route toolbar hidden`)
        assert(state.mobileSearchRowDisplay !== 'none', `${label}: search route row hidden`)
      } else {
        assert(state.mobileToolbarDisplay === 'none', `${label}: collapsed search route toolbar display ${state.mobileToolbarDisplay}`)
        assert(state.mobileSearchRowDisplay === 'none', `${label}: collapsed search route row display ${state.mobileSearchRowDisplay}`)
      }
    } else {
      assert(state.triggerText === '搜索', `${label}: trigger text ${state.triggerText}`)
      assert(state.triggerExpanded === 'false', `${label}: trigger expanded ${state.triggerExpanded}`)
      assert(state.mobileToolbarDisplay === 'none', `${label}: collapsed mobile toolbar display ${state.mobileToolbarDisplay}`)
      assert(state.mobileSearchRowDisplay === 'none', `${label}: collapsed search row display ${state.mobileSearchRowDisplay}`)
    }
    assert(state.menuText === theme.menuText, `${label}: menu text ${state.menuText}`)
    assert(state.menuAria === theme.menuAria, `${label}: menu aria ${state.menuAria}`)

    if (!initiallyExpanded) {
      await page.click('.el-public-shell__mobile-search-trigger')
      await page.waitForSelector('.el-public-shell__mobile-search-row', { state: 'visible', timeout: 5000 })
    }
    const expanded = await page.evaluate(() => {
      const trigger = document.querySelector('.el-public-shell__mobile-search-trigger')
      const toolbar = document.querySelector('.el-public-shell__mobile-toolbar')
      const row = document.querySelector('.el-public-shell__mobile-search-row')
      const search = row?.querySelector('.el-public-shell__search')
      const input = row?.querySelector('input.el-input__inner')
      return {
        triggerText: trigger?.textContent?.trim() ?? '',
        triggerExpanded: trigger?.getAttribute('aria-expanded') ?? '',
        toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : '',
        rowWidth: row?.getBoundingClientRect().width ?? 0,
        searchWidth: search?.getBoundingClientRect().width ?? 0,
        activeInput: document.activeElement === input,
        placeholder: input?.getAttribute('placeholder') ?? '',
      }
    })
    assert(expanded.triggerText === '取消', `${label}: expanded trigger text ${expanded.triggerText}`)
    assert(expanded.triggerExpanded === 'true', `${label}: expanded aria ${expanded.triggerExpanded}`)
    assert(expanded.toolbarDisplay !== 'none', `${label}: expanded toolbar display ${expanded.toolbarDisplay}`)
    assert(expanded.searchWidth >= expanded.rowWidth - 2, `${label}: expanded search width ${expanded.searchWidth}, row ${expanded.rowWidth}`)
    if (!initiallyExpanded) {
      assert(expanded.activeInput, `${label}: expanded search input not focused`)
    }
    assert(expanded.placeholder.startsWith('搜索文章、标签或关键词'), `${label}: search placeholder ${expanded.placeholder}`)
  } else {
    assert(state.desktopActionsDisplay !== 'none', `${label}: desktop actions hidden`)
    assert(state.desktopNavDisplay !== 'none', `${label}: desktop nav hidden`)
    assert(state.primaryActionsDisplay === 'none', `${label}: mobile primary actions visible on desktop`)
    assert(state.mobileToolbarDisplay === 'none', `${label}: mobile toolbar visible on desktop`)
    assert(state.desktopSearchWidth >= 170 && state.desktopSearchWidth <= 180, `${label}: desktop search width ${state.desktopSearchWidth}`)
    for (const [boxLabel, box] of [
      ['brand', state.brandBox],
      ['desktop nav', state.desktopNavLinkBox],
      ['desktop search', state.desktopSearchBox],
      ['desktop theme', state.desktopThemeBox],
      ['desktop auth', state.desktopAuthBox],
    ]) {
      assertBoxMetric(box, 'height', 40, `${label}: ${boxLabel}`)
      assertBoxMetric(
        { centerY: Math.abs(box.centerY - state.primaryBox.centerY) },
        'centerY',
        0,
        `${label}: ${boxLabel} center delta`,
      )
    }
  }
}

async function main() {
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  }
  if (executablePath) {
    launchOptions.executablePath = executablePath
  }

  const browser = await chromium.launch(launchOptions)
  try {
    for (const theme of activeThemeScenarios) {
      for (const authMode of activeAuthModes) {
        const context = await browser.newContext({
          baseURL: baseUrl,
          colorScheme: theme.colorScheme,
          viewport: { width: 1024, height: 900 },
        })
        await context.addInitScript((mode) => {
          window.localStorage.setItem('fsus:theme-mode', mode)
        }, theme.storageMode)
        await installAuthFixture(context, authMode)

        const page = await context.newPage()
        page.setDefaultTimeout(10000)
        for (const width of activeWidths) {
          for (const route of activeRoutes) {
            await page.setViewportSize({ width, height: 900 })
            if (verbose) {
              console.log(`[public-header-material] check theme=${theme.name} auth=${authMode.name} width=${width} route=${route}`)
            }
            await inspectHeader(page, width, route, theme, authMode)
          }
        }
        await page.close()

        await context.close()
      }
    }
  } finally {
    await browser.close()
  }

  console.log(`[public-header-material] ok widths=${activeWidths.length} routes=${activeRoutes.length} themes=${activeThemeScenarios.length} auth=${activeAuthModes.length} full=${fullMatrix ? 1 : 0}`)
}

main().catch((error) => {
  console.error(`[public-header-material] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
