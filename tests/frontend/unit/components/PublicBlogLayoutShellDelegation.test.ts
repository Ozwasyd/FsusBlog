// @vitest-environment happy-dom

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mount, type DOMWrapper } from '@vue/test-utils'
import { createSSRApp, defineComponent, h, nextTick } from 'vue'
import { ElThemeModeToggle } from '@ozwasyd/element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import { FsusUiPublicShell } from '@/fsusui/publicShell'
import {
  activateLocaleRuntime,
  createLocaleTextContext,
  ENABLED_LOCALES,
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
    expect(html).not.toMatch(/\sstyle=/u)
    expect(html).toContain('data-locale-selector-runtime-adapter')
    expect(html).toContain('data-locale-selector-item')
  })

  it.each(ENABLED_LOCALES)('projects $code typed copy and catalog through real local PublicShell SSR', async ({ code }) => {
    const localeSnapshot = await prepareLocaleDomains(
      code,
      ['common', 'layout', 'public']
    )
    const copy = createLocaleTextContext(localeSnapshot)
    for (const { authAction, authHref } of [
      { authAction: 'login', authHref: '/login' },
      { authAction: 'account', authHref: '/user/profile' },
      { authAction: 'dashboard', authHref: '/admin' },
    ] as const) {
      const app = createSSRApp({
        render: () => h(PublicBlogLayoutShell, {
          initialLocale: code,
          authAction,
          authHref,
        }),
      })
      provideLocaleTextContext(app, localeSnapshot)
      app.component('ElThemeModeToggle', ElThemeModeToggle)

      const html = await renderToString(app)
      const rendered = document.createElement('div')
      rendered.innerHTML = html
      expect(rendered.querySelector('#fsus-aot-shell')?.getAttribute('data-public-render-locale')).toBe(code)
      expect(rendered.querySelector('#fsus-aot-shell')?.getAttribute('data-public-auth-message-key'))
        .toBe(`public.shell.${authAction}`)
      const authLinks = [...rendered.querySelectorAll('[data-public-nav="auth"]')]
      expect(authLinks).toHaveLength(2)
      for (const link of authLinks) {
        expect(link.textContent?.trim()).toBe(copy.translate(`public.shell.${authAction}`))
        expect(link.getAttribute('href')).toBe(authHref)
      }
      for (const key of ['home', 'archive', 'about'] as const) {
        const links = [...rendered.querySelectorAll(`nav [data-public-nav="${key}"]`)]
        expect(links).toHaveLength(2)
        expect(links.map((link) => link.textContent?.trim()))
          .toEqual([copy.translate(`public.shell.${key}`), copy.translate(`public.shell.${key}`)])
      }
      expect(rendered.querySelector('[data-mobile-nav-menu-trigger]')?.textContent?.trim())
        .toBe(copy.translate('public.shell.mobileMenu'))
      expect(rendered.querySelector('.el-public-shell__desktop-search-trigger')?.getAttribute('aria-label'))
        .toBe(copy.translate('public.shell.search'))
      expect(html).not.toMatch(/\sstyle=/u)

      const themeControls = [...rendered.querySelectorAll('[data-theme-mode-visibility]')]
      expect(themeControls.map((control) => control.getAttribute('data-theme-mode-visibility')))
        .toEqual(['desktop', 'mobile'])
      for (const control of themeControls) {
        for (const mode of ['light', 'dark', 'system'] as const) {
          const option = control.querySelector(`[data-theme-mode="${mode}"]`)
          expect(option?.textContent?.trim()).toBe(copy.translate(`public.shell.${mode}`))
          if (option?.getAttribute('aria-checked') === 'true') {
            const trigger = control.querySelector('[aria-haspopup="menu"]')
            expect(trigger?.textContent?.trim()).toBe(copy.translate(`public.shell.${mode}Short`))
            expect(trigger?.getAttribute('aria-label'))
              .toBe(`${copy.translate('layout.themeMode.label')}: ${copy.translate(`public.shell.${mode}`)}`)
          }
        }
      }

      const menus = [...rendered.querySelectorAll('[data-locale-selector-menu]')]
      expect(menus).toHaveLength(2)
      for (const menu of menus) {
        const items = [...menu.querySelectorAll('[data-locale-selector-item]')]
        expect(items.map((item) => item.getAttribute('data-locale-code')))
          .toEqual(ENABLED_LOCALES.map((locale) => locale.code))
        expect(items.map((item) => item.querySelector('.locale-selector__item-native')?.textContent))
          .toEqual(ENABLED_LOCALES.map((locale) => locale.nativeName))
        expect(items.map((item) => item.querySelector('.locale-selector__item-english')?.textContent ?? null))
          .toEqual(ENABLED_LOCALES.map((locale) => locale.englishName === locale.nativeName ? null : locale.englishName))
        expect(items.map((item) => item.getAttribute('dir')))
          .toEqual(ENABLED_LOCALES.map((locale) => locale.direction))
        expect(items.map((item) => item.getAttribute('aria-disabled')))
          .toEqual(ENABLED_LOCALES.map(() => null))
        expect(items.map((item) => item.getAttribute('aria-checked')))
          .toEqual(ENABLED_LOCALES.map((locale) => locale.code === code ? 'true' : 'false'))
        expect([...menu.querySelectorAll('[aria-current="true"]')].map((item) => item.getAttribute('data-locale-code')))
          .toEqual([code])
      }
    }
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
      (links: DOMWrapper<Element>[]) => links.every((link) => link.attributes('href') === '/user/profile'),
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
