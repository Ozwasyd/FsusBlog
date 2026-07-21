// @vitest-environment happy-dom

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { createSSRApp, defineComponent, h, nextTick } from 'vue'
import { ElThemeModeToggle } from '@ozwasyd/element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PublicBlogLayoutShell from '@/components/public/PublicBlogLayoutShell.vue'
import { FsusUiPublicShell } from '@/fsusui/publicShell'

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
      authLabel: '账户',
      authHref: '/user/profile',
      initialSearchQuery: 'initial',
      searchPlaceholder: '搜索文章',
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
  document.body.innerHTML = ''
})

describe('PublicBlogLayoutShell PublicShell delegation', () => {
  it('keeps native auth and search fallbacks in CSP-safe server output', async () => {
    const app = createSSRApp({
      render: () => h(PublicBlogLayoutShell, {
        authLabel: '账户',
        authHref: '/user/profile',
      }),
    })
    app.component('ElThemeModeToggle', ElThemeModeToggle)

    const html = await renderToString(app)

    expect(html).toContain('el-public-shell__desktop-search-trigger')
    expect(html).toContain('href="/search"')
    expect(html).toContain('href="/user/profile"')
    expect(html).toContain('data-public-nav="auth"')
    expect(html).toContain('is-csp-hidden')
    expect(html).not.toMatch(/\sstyle=/u)
  })

  it('passes auth and desktop search state to the local FsusUI PublicShell contract', () => {
    const wrapper = mountShell()
    const shell = wrapper.findComponent(FsusUiPublicShell)

    expect(shell.props()).toMatchObject({
      authLabel: '账户',
      authHref: '/user/profile',
      desktopSearchMode: 'trigger',
      desktopSearchTriggerLabel: '',
      searchAction: '/search',
      searchName: 'q',
      searchQuery: 'initial',
      searchPlaceholder: '搜索文章',
      spaSearch: true,
      cspSafe: true,
    })

    expect(wrapper.find('.public-chrome-search').exists()).toBe(false)
    expect(wrapper.find('a.el-public-shell__desktop-search-trigger').attributes('href')).toBe('/search')
    expect(wrapper.findAll('a[data-public-nav="auth"]')).toHaveLength(2)
    expect(wrapper.findAll('a[data-public-nav="auth"]')).toSatisfy(
      (links) => links.every((link) => link.attributes('href') === '/user/profile'),
    )
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
  })
})
