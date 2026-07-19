#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { encodeAdminPrincipalSnapshotFrame, encodeIdentityAccountSnapshotFrame } from '../../support/aeds-envelope.mjs'
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))

const baseUrl =
  process.env.PLAYWRIGHT_BASE_URL
  || process.env.FSUSBLOG_PUBLIC_BASE_URL
  || process.env.FSUSBLOG_BASE_URL
  || 'http://127.0.0.1:3000'

const executablePath = resolveSystemChromiumExecutablePath()

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
  await page.waitForSelector('#fsus-aot-shell > .el-public-shell', { timeout: 10000 })
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
    const shell = document.querySelector('#fsus-aot-shell > .el-public-shell')
    const primaryActions = document.querySelector('.el-public-shell__mobile-primary-actions')
    const mobileToolbar = document.querySelector('.el-public-shell__mobile-toolbar')
    const mobileSearchRow = document.querySelector('.el-public-shell__mobile-search-row')
    const trigger = document.querySelector('.el-public-shell__mobile-search-trigger')
    const mobileMenu = document.querySelector('.el-public-shell__mobile-nav-menu')
    const mobileMenuTrigger = document.querySelector('.el-public-shell__mobile-nav-menu-trigger')
    const mobileMenuPanel = document.querySelector('.el-public-shell__mobile-nav-menu-panel')
    const menuButton = document.querySelector('.el-theme-mode-toggle__menu-button')
    const mobileThemeButton = document.querySelector('.el-theme-mode-toggle--mobile .el-theme-mode-toggle__menu-button')
    const desktopActions = document.querySelector('.el-public-shell__actions')
    const desktopNav = document.querySelector('.el-public-shell__desktop-nav')
    const desktopSearchTrigger = document.querySelector('.public-chrome-search__trigger')
    const authLink = document.querySelector('.el-public-shell__auth-link')
    const mobileAuthLink = document.querySelector('.el-public-shell__auth-link--mobile')
    const colophon = document.querySelector('.public-colophon')
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
      hasPublicHeaderHook: Boolean(document.querySelector('[data-public-shell-header]')),
      mobileNavMode: shell?.getAttribute('data-mobile-nav-mode') ?? '',
      consumerMobileNavMode: shell?.getAttribute('data-public-mobile-nav-mode') ?? '',
      hasBottomTab: Boolean(document.querySelector('[data-fsus-bottom-tab-bar], .el-public-shell__bottom-tab, .fsusblog-public-bottom-tab')),
      hasLegacyConsumerMenu: Boolean(document.querySelector('.public-mobile-nav-menu')),
      headerBackground: headerStyle?.backgroundColor ?? '',
      headerBackgroundImage: headerStyle?.backgroundImage ?? '',
      headerBorderBottomColor: headerStyle?.borderBottomColor ?? '',
      headerBoxShadow: headerStyle?.boxShadow ?? '',
      headerBackdropFilter: headerStyle?.backdropFilter ?? headerStyle?.webkitBackdropFilter ?? '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      primaryActionsDisplay: getDisplay(primaryActions),
      mobileToolbarDisplay: getDisplay(mobileToolbar),
      mobileToolbarCollapsed: mobileToolbar?.classList.contains('is-collapsed') ?? false,
      mobileSearchRowDisplay: getDisplay(mobileSearchRow),
      mobileSearchTag: trigger?.tagName ?? '',
      mobileSearchHref: trigger?.getAttribute('href') ?? '',
      triggerText: trigger?.textContent?.trim() ?? '',
      triggerExpanded: trigger?.getAttribute('aria-expanded') ?? '',
      mobileMenuText: mobileMenuTrigger?.textContent?.trim() ?? '',
      mobileMenuExpanded: mobileMenuTrigger?.getAttribute('aria-expanded') ?? '',
      hasMobileMenu: Boolean(mobileMenu),
      hasMobileMenuPanel: Boolean(mobileMenuPanel),
      menuInPrimaryActions: Boolean(primaryActions && mobileMenu && primaryActions.contains(mobileMenu)),
      searchInPrimaryActions: Boolean(primaryActions && trigger && primaryActions.contains(trigger)),
      themeInMenuPanel: Boolean(mobileMenuPanel && mobileThemeButton && mobileMenuPanel.contains(mobileThemeButton)),
      authInMenuPanel: Boolean(mobileMenuPanel && mobileAuthLink && mobileMenuPanel.contains(mobileAuthLink)),
      menuText: menuButton?.textContent?.trim() ?? '',
      menuAria: menuButton?.getAttribute('aria-label') ?? '',
      desktopActionsDisplay: getDisplay(desktopActions),
      desktopNavDisplay: getDisplay(desktopNav),
      desktopSearchWidth: getWidth(desktopSearchTrigger),
      desktopSearchExpanded: desktopSearchTrigger?.getAttribute('aria-expanded') ?? '',
      hasPersistentDesktopInput: Boolean(document.querySelector('.public-chrome-search--desktop input')),
      innerBox: getBox(document.querySelector('.el-public-shell__inner')),
      primaryBox: getBox(document.querySelector('.el-public-shell__primary-row')),
      brandBox: getBox(document.querySelector('.el-public-shell__brand')),
      desktopNavLinkBox: getBox(document.querySelector('.el-public-shell__desktop-nav .el-public-shell__nav-link')),
      desktopSearchBox: getBox(desktopSearchTrigger),
      desktopThemeBox: getBox(document.querySelector('.el-theme-mode-toggle--desktop')),
      desktopAuthBox: getBox(document.querySelector('.el-public-shell__actions .el-public-shell__auth-link')),
      mobileSearchBox: getBox(trigger),
      mobileMenuBox: getBox(mobileMenuTrigger),
      authText: authLink?.textContent?.trim() ?? '',
      authHref: authLink?.getAttribute('href') ?? '',
      hasColophon: Boolean(colophon),
      hasPrimaryColophon: Boolean(colophon?.querySelector('.public-colophon__primary')),
      hasSecondaryColophon: Boolean(colophon?.querySelector('.public-colophon__secondary')),
      hasRssColophonLink: Boolean(colophon?.querySelector('.public-colophon__primary a[href="/feed/rss.xml"]')),
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
  assert(state.hasPublicHeaderHook, `${label}: stable FsusUI public header hook is missing`)
  assert(state.mobileNavMode === 'menu', `${label}: mobile nav mode ${state.mobileNavMode}`)
  assert(state.consumerMobileNavMode === 'menu', `${label}: consumer mobile nav mode ${state.consumerMobileNavMode}`)
  assert(!state.hasBottomTab, `${label}: fixed bottom navigation must not render`)
  assert(!state.hasLegacyConsumerMenu, `${label}: Blog-owned mobile menu must not render`)
  assert(state.hasColophon, `${label}: public colophon missing`)
  assert(state.hasPrimaryColophon, `${label}: primary colophon row missing`)
  assert(state.hasSecondaryColophon, `${label}: secondary colophon row missing`)
  assert(state.hasRssColophonLink, `${label}: RSS colophon link missing`)
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
    assert(state.mobileSearchTag === 'A', `${label}: mobile search trigger tag ${state.mobileSearchTag}`)
    assert(state.mobileSearchHref === '/search', `${label}: mobile search fallback href ${state.mobileSearchHref}`)
    assert(state.menuInPrimaryActions, `${label}: FsusUI menu is not owned by mobile primary actions`)
    assert(state.searchInPrimaryActions, `${label}: FsusUI search trigger is not owned by mobile primary actions`)
    assert(state.themeInMenuPanel, `${label}: mobile theme must stay inside the menu utility group`)
    assert(state.authInMenuPanel, `${label}: mobile auth must stay inside the menu utility group`)
    for (const [boxLabel, box] of [
      ['brand', state.brandBox],
      ['mobile search', state.mobileSearchBox],
      ['mobile menu', state.mobileMenuBox],
    ]) {
      assertBoxMetric(box, 'height', 44, `${label}: ${boxLabel}`)
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
        assert(!state.mobileToolbarCollapsed, `${label}: expanded search toolbar is marked collapsed`)
        assert(state.mobileToolbarDisplay !== 'none', `${label}: search route toolbar hidden`)
        assert(state.mobileSearchRowDisplay !== 'none', `${label}: search route row hidden`)
      } else {
        assert(state.mobileToolbarCollapsed, `${label}: collapsed search toolbar class missing`)
        assert(state.mobileToolbarDisplay === 'none', `${label}: collapsed search route toolbar display ${state.mobileToolbarDisplay}`)
        assert(state.mobileSearchRowDisplay === 'none', `${label}: collapsed search route row display ${state.mobileSearchRowDisplay}`)
      }
    } else {
      assert(state.triggerText === '搜索', `${label}: trigger text ${state.triggerText}`)
      assert(state.triggerExpanded === 'false', `${label}: trigger expanded ${state.triggerExpanded}`)
      assert(state.mobileToolbarCollapsed, `${label}: collapsed mobile toolbar class missing`)
      assert(state.mobileToolbarDisplay === 'none', `${label}: collapsed mobile toolbar display ${state.mobileToolbarDisplay}`)
      assert(state.mobileSearchRowDisplay === 'none', `${label}: collapsed search row display ${state.mobileSearchRowDisplay}`)
    }
    assert(state.hasMobileMenu, `${label}: native mobile menu missing`)
    assert(state.hasMobileMenuPanel, `${label}: FsusUI mobile menu panel missing`)
    assert(state.mobileMenuText === '菜单', `${label}: mobile menu text ${state.mobileMenuText}`)
    assert(state.mobileMenuExpanded === 'false', `${label}: mobile menu expanded ${state.mobileMenuExpanded}`)
    assert(state.menuText === theme.menuText, `${label}: menu text ${state.menuText}`)
    assert(state.menuAria === theme.menuAria, `${label}: menu aria ${state.menuAria}`)

    await page.click('.el-public-shell__mobile-nav-menu-trigger')
    await page.waitForSelector('.el-public-shell__mobile-nav-menu-panel', { state: 'visible', timeout: 5000 })
    const mobileMenuState = await page.evaluate(() => {
      const primaryActions = document.querySelector('.el-public-shell__mobile-primary-actions')
      const panel = document.querySelector('.el-public-shell__mobile-nav-menu-panel')
      const getHeight = (selector) => {
        const element = panel?.querySelector(selector)
        return element ? Number(element.getBoundingClientRect().height.toFixed(2)) : 0
      }
      return {
        expanded: document.querySelector('.el-public-shell__mobile-nav-menu-trigger')?.getAttribute('aria-expanded') ?? '',
        current: panel?.querySelector('.el-public-shell__mobile-nav-link[aria-current="page"]')?.getAttribute('data-public-nav') ?? '',
        linkCount: panel?.querySelectorAll('.el-public-shell__mobile-nav-link').length ?? 0,
        panelInPrimaryActions: Boolean(primaryActions && panel && primaryActions.contains(panel)),
        themeInPanel: Boolean(panel?.querySelector('.el-theme-mode-toggle')),
        authInPanel: Boolean(panel?.querySelector('.el-public-shell__auth-link')),
        themeHeight: getHeight('.el-theme-mode-toggle__menu-button'),
        authHeight: getHeight('.el-public-shell__auth-link'),
      }
    })
    assert(mobileMenuState.expanded === 'true', `${label}: menu did not expand`)
    assert(mobileMenuState.linkCount === 3, `${label}: FsusUI menu link count ${mobileMenuState.linkCount}`)
    assert(mobileMenuState.panelInPrimaryActions, `${label}: FsusUI menu panel is outside primary actions`)
    assert(mobileMenuState.themeInPanel, `${label}: mobile theme utility is missing from menu panel`)
    assert(mobileMenuState.authInPanel, `${label}: mobile auth utility is missing from menu panel`)
    assertNear(mobileMenuState.themeHeight, 44, 1, `${label}: mobile theme menu height`)
    assertNear(mobileMenuState.authHeight, 44, 1, `${label}: mobile auth menu height`)
    if (!route.startsWith('/search')) {
      assert(Boolean(mobileMenuState.current), `${label}: menu current item missing`)
    }
    await page.press('.el-public-shell__mobile-nav-menu-trigger', 'Escape')
    const menuFocusRestored = await page.evaluate(() => {
      const trigger = document.querySelector('.el-public-shell__mobile-nav-menu-trigger')
      return trigger?.getAttribute('aria-expanded') === 'false' && document.activeElement === trigger
    })
    assert(menuFocusRestored, `${label}: Escape did not close menu and restore focus`)

    if (initiallyExpanded) {
      await page.press('.el-public-shell__mobile-search-row input', 'Escape')
      const initiallyExpandedFocusRestored = await page.evaluate(() => {
        const trigger = document.querySelector('.el-public-shell__mobile-search-trigger')
        const toolbar = document.querySelector('.el-public-shell__mobile-toolbar')
        return trigger?.getAttribute('aria-expanded') === 'false'
          && document.activeElement === trigger
          && toolbar?.classList.contains('is-collapsed')
      })
      assert(initiallyExpandedFocusRestored, `${label}: initial mobile search Escape did not collapse and restore focus`)
    }

    await page.click('.el-public-shell__mobile-search-trigger')
    await page.waitForSelector('.el-public-shell__mobile-search-row', { state: 'visible', timeout: 5000 })
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
    assert(expanded.activeInput, `${label}: expanded search input not focused`)
    assert(expanded.placeholder.startsWith('搜索文章、标签或关键词'), `${label}: search placeholder ${expanded.placeholder}`)
    await page.press('.el-public-shell__mobile-search-row input', 'Escape')
    const mobileSearchFocusRestored = await page.evaluate(() => {
      const trigger = document.querySelector('.el-public-shell__mobile-search-trigger')
      const toolbar = document.querySelector('.el-public-shell__mobile-toolbar')
      return trigger?.getAttribute('aria-expanded') === 'false'
        && document.activeElement === trigger
        && toolbar?.classList.contains('is-collapsed')
        && getComputedStyle(toolbar).display === 'none'
    })
    assert(mobileSearchFocusRestored, `${label}: mobile search Escape did not collapse and restore focus`)
  } else {
    assert(state.desktopActionsDisplay !== 'none', `${label}: desktop actions hidden`)
    assert(state.desktopNavDisplay !== 'none', `${label}: desktop nav hidden`)
    assert(state.primaryActionsDisplay === 'none', `${label}: mobile primary actions visible on desktop`)
    assert(state.mobileToolbarDisplay === 'none', `${label}: mobile toolbar visible on desktop`)
    assert(state.desktopSearchWidth >= 40, `${label}: desktop search trigger width ${state.desktopSearchWidth}`)
    assert(state.desktopSearchExpanded === 'false', `${label}: desktop search initially expanded`)
    assert(!state.hasPersistentDesktopInput, `${label}: desktop input must be on demand`)
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

    await page.click('.public-chrome-search__trigger')
    await page.waitForSelector('.public-chrome-search__panel input', { state: 'visible', timeout: 5000 })
    const desktopSearchState = await page.evaluate(() => {
      const trigger = document.querySelector('.public-chrome-search__trigger')
      const input = document.querySelector('.public-chrome-search__panel input')
      return {
        expanded: trigger?.getAttribute('aria-expanded') ?? '',
        activeInput: document.activeElement === input,
      }
    })
    assert(desktopSearchState.expanded === 'true', `${label}: desktop search did not expand`)
    assert(desktopSearchState.activeInput, `${label}: desktop search input not focused`)
    await page.press('.public-chrome-search__panel input', 'Escape')
    const desktopFocusRestored = await page.evaluate(() => {
      const trigger = document.querySelector('.public-chrome-search__trigger')
      return trigger?.getAttribute('aria-expanded') === 'false' && document.activeElement === trigger
    })
    assert(desktopFocusRestored, `${label}: desktop Escape did not restore search trigger focus`)
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
