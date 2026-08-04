// @vitest-environment happy-dom

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { createSSRApp, defineComponent, h, nextTick } from 'vue'
import { ElThemeModeToggle } from '@ozwasyd/element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import { FsusUiPublicShell } from '@/fsusui/publicShell'
import {
  activateLocaleRuntime,
  prepareLocaleDomains,
  provideLocaleTextContext,
  resetLocaleRuntimeForTests
} from '@/locales'

const frontendRequire = createRequire(resolve(process.cwd(), 'package.json'))
const { renderToString } = frontendRequire('@vue/server-renderer') as typeof import('@vue/server-renderer')

const ThemeModeToggleStub = defineComponent({
  props: {
    labels: Object,
    variant: String,
    visibility: String,
  },
  template: '<button type="button">主题</button>',
})

const LocaleSelectorRuntimeAdapterStub = defineComponent({
  props: {
    compact: Boolean,
  },
  template: '<div data-locale-selector-runtime-adapter :data-compact="compact ? \'true\' : \'false\'"></div>',
})

function mountShell() {
  return mount(PublicBlogLayoutShell, {
    attachTo: document.body,
    props: {
      authAction: 'account',
      authHref: '/user/profile',
      initialSearchQuery: 'initial',
      searchAction: 'search',
      spaSearch: true,
    },
    global: {
      stubs: {
        ThemeModeToggle: ThemeModeToggleStub,
        LocaleSelectorRuntimeAdapter: LocaleSelectorRuntimeAdapterStub,
        PublicComplianceFooter: true,
      },
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  resetLocaleRuntimeForTests()
  document.body.innerHTML = ''
})

describe('PublicBlogLayoutShell PublicShell delegation', () => {
  beforeEach(async () => {
    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public'])
  })

  it('keeps native auth and search fallbacks in CSP-safe server output', async () => {
    const localeSnapshot = await prepareLocaleDomains('zh-CN', ['common', 'layout', 'public'])
    const app = createSSRApp({
      render: () => h(PublicBlogLayoutShell, {
        authAction: 'account',
        authHref: '/user/profile',
      }),
    })
    provideLocaleTextContext(app, localeSnapshot)
    app.component('ElThemeModeToggle', ElThemeModeToggle)

    const html = await renderToString(app)

    expect(html).toContain('el-public-shell__desktop-search-trigger')
    expect(html).toContain('href="/search"')
    expect(html).toContain('href="/user/profile"')
    expect(html).toContain('data-public-nav="auth"')
    expect(html).toContain('is-csp-hidden')
    // LocaleSelector keeps closed menus with v-show (display:none). Strip only that
    // contract-owned closed state before asserting the public shell stays CSP-safe.
    const withoutLocaleMenuClosedStyle = html.replace(
      /(<div[^>]*data-locale-selector-menu[^>]*?)\sstyle="display:none;"/gu,
      '$1',
    )
    expect(withoutLocaleMenuClosedStyle).not.toMatch(/\sstyle=/u)
    expect(html).toContain('data-locale-selector-runtime-adapter')
    expect(html).toContain('data-locale-selector-item')
  })

  it.each([
    ['en-US', 'Log in', 'Menu', 'Search', /登录|菜单|搜索/u],
    ['zh-CN', '登录', '菜单', '搜索', /\bLog in\b|\bMenu\b|\bSearch\b/u],
  ] as const)('projects %s from one locale bundle during server render', async (
    initialLocale,
    authLabel,
    menuLabel,
    searchLabel,
    foreignChrome,
  ) => {
    const localeSnapshot = await prepareLocaleDomains(
      initialLocale,
      ['common', 'layout', 'public']
    )
    const app = createSSRApp({
      render: () => h(PublicBlogLayoutShell, {
        authAction: 'login',
        authHref: '/login'
      }),
    })
    provideLocaleTextContext(app, localeSnapshot)
    app.component('ElThemeModeToggle', ElThemeModeToggle)

    const html = await renderToString(app)

    expect(html).toContain(`data-public-auth-message-key="public.shell.login"`)
    expect(html).toContain(`>${menuLabel}</summary>`)
    expect(html).toContain(`aria-label="${searchLabel}"`)
    expect(html).toContain(`>${authLabel}</a>`)
    expect(html).not.toMatch(foreignChrome)
  })

  it('passes auth and desktop search state to the local FsusUI PublicShell contract', () => {
    const wrapper = mountShell()
    const shell = wrapper.findComponent(FsusUiPublicShell)

    expect(shell.props()).toMatchObject({
      authLabel: '账户',
      authHref: '/user/profile',
      desktopSearchMode: 'trigger',
      desktopSearchTriggerLabel: '搜索',
      searchAction: '/search',
      searchName: 'q',
      searchQuery: 'initial',
      searchPlaceholder: '搜索文章、标签或关键词',
      spaSearch: true,
      cspSafe: true,
    })

    expect(wrapper.find('.public-chrome-search').exists()).toBe(false)
    expect(wrapper.find('a.el-public-shell__desktop-search-trigger').attributes('href')).toBe('/search')
    expect(wrapper.findAll('a[data-public-nav="auth"]')).toHaveLength(2)
    expect(wrapper.findAll('a[data-public-nav="auth"]')).toSatisfy(
      (links) => links.every((link) => link.attributes('href') === '/user/profile'),
    )
    wrapper.unmount()
  })

  it('keeps the query controlled and forwards product search intent', async () => {
    const wrapper = mountShell()
    const shell = wrapper.findComponent(FsusUiPublicShell)

    shell.vm.$emit('update:searchQuery', '  delegated  ')
    await nextTick()
    expect(shell.props('searchQuery')).toBe('delegated')

    shell.vm.$emit('search', ' delegated ')
    await nextTick()
    expect(wrapper.emitted('search')).toEqual([[' delegated ']])
    expect(shell.props('searchQuery')).toBe('delegated')
    wrapper.unmount()
  })

  it('delegates a mutated public-nav href through the SPA navigation contract', async () => {
    const wrapper = mountShell()
    await wrapper.setProps({ spaNavigation: true })
    const link = wrapper.get('a[data-public-nav="auth"]')
    link.element.setAttribute('href', '/article/4')

    await link.trigger('click')

    expect(wrapper.emitted('navigate')).toEqual([['/article/4']])
    wrapper.unmount()
  })

  it('marks only ArticleDetail content as content-driven', async () => {
    const wrapper = mountShell()
    const content = wrapper.get('#main-content')

    expect(content.attributes('data-public-content-flow')).toBeUndefined()

    await wrapper.setProps({ hydrationKind: 'ArticleDetail' })
    expect(content.attributes('data-public-content-flow')).toBe('content-driven')

    await wrapper.setProps({ hydrationKind: 'Home' })
    expect(content.attributes('data-public-content-flow')).toBeUndefined()
    wrapper.unmount()
  })

  it('places LocaleSelectorRuntimeAdapter in desktop actions and mobile menu utilities', () => {
    const wrapper = mountShell()
    const adapters = wrapper.findAll('[data-locale-selector-runtime-adapter]')
    expect(adapters).toHaveLength(2)
    expect(adapters.some((node) => node.attributes('data-compact') === 'true')).toBe(true)
    expect(adapters.some((node) => node.attributes('data-compact') !== 'true')).toBe(true)
    expect(wrapper.find('.fsusblog-public-mobile-menu-utilities [data-locale-selector-runtime-adapter]').exists())
      .toBe(true)
    wrapper.unmount()
  })
})
