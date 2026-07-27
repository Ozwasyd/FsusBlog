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
  initializeLocaleRuntime,
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
    await initializeLocaleRuntime('zh-CN', ['common', 'layout', 'public'])
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
})
