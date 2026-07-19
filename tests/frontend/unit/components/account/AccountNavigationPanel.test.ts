// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { h, nextTick } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  type Router
} from 'vue-router'
import { describe, expect, it } from 'vitest'
import AccountNavigationPanel from '@/components/account/AccountNavigationPanel.vue'
import { getAccountNavGroups } from '@/layouts/accountNav'

const panelSource = readFileSync(
  resolve(process.cwd(), 'src/components/account/AccountNavigationPanel.vue'),
  'utf8'
)

const permissions = [
  'admin.manage',
  'article.write',
  'comment.moderate',
  'anonymous.comment.configure',
  'anonymous.credential.revoke',
  'anonymous.nullifier.block',
  'system.config',
  'audit.read'
]

const groups = getAccountNavGroups({
  surface: 'manage',
  canManage: true,
  permissions,
  features: {
    anonymousCommentsEnabled: true,
    zkAnonymousEnabled: true,
    publicSendOptionEnabled: true
  },
  policies: {
    anonymousCommentGovernanceAvailable: true,
    zkAnonymousConfigurable: true
  }
})

const createTestRouter = async (path: string): Promise<Router> => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => h('div') } }]
  })
  await router.push(path)
  await router.isReady()
  return router
}

const mountPanel = async (path: string, variant: 'desktop' | 'mobile' = 'desktop') => {
  const router = await createTestRouter(path)
  const wrapper = mount(AccountNavigationPanel, {
    props: {
      areaLabel: '管理',
      groups,
      headingId: variant === 'desktop' ? 'account-shell-area-title' : '',
      variant
    },
    global: {
      plugins: [router]
    }
  })
  return { router, wrapper }
}

describe('AccountNavigationPanel', () => {
  it('keeps first-level and local navigation on distinct visual hierarchy roles', () => {
    expect(panelSource).toMatch(/\.account-module-link__label\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*700;/u)
    expect(panelSource).toMatch(/\.account-local-navigation__link > span:first-child\s*\{[^}]*font-size:\s*12px;[^}]*font-weight:\s*500;/u)
    expect(panelSource).toMatch(/\.account-local-navigation__title\s*\{[^}]*\}\s*\.account-local-navigation__link\s*\{[^}]*padding:\s*0\.375rem 0\.5rem 0\.375rem 2rem;/u)
    expect(panelSource).toMatch(/\.account-navigation-panel\[data-variant="desktop"\] \.account-local-navigation__link\s*\{[^}]*min-height:\s*2\.5rem;/u)
    expect(panelSource).toMatch(/\.account-module-link,\s*\.account-local-navigation__link\s*\{[^}]*min-height:\s*2\.75rem;/u)
    expect(panelSource).not.toMatch(/font-weight:\s*680;|font-size:\s*13px;|min-height:\s*2\.25rem;/u)
  })

  it('renders no more than six global links and only the current module leaves', async () => {
    const { wrapper } = await mountPanel('/user/manage/article/edit/42')

    expect(wrapper.get('[aria-label="管理一级模块"]').findAll('.account-module-link')).toHaveLength(6)
    expect(wrapper.get('[aria-label="内容局部导航"]').findAll('.account-local-navigation__link'))
      .toHaveLength(5)
    expect(wrapper.get('.account-module-link-active').text()).toContain('内容')
    expect(wrapper.get('.account-local-navigation__link--active').text()).toContain('文章')
    expect(wrapper.find('[aria-label="互动局部导航"]').exists()).toBe(false)
  })

  it('updates module and page current state on deep navigation and browser back', async () => {
    const { router, wrapper } = await mountPanel('/user/manage/article/list')

    await router.push('/user/manage/messages')
    await nextTick()
    expect(wrapper.get('.account-module-link-active').text()).toContain('互动')
    expect(wrapper.get('[aria-label="互动局部导航"]')).toBeTruthy()
    expect(wrapper.get('.account-local-navigation__link--active').text()).toContain('站内信')

    const restored = new Promise<void>((resolve) => {
      const removeGuard = router.afterEach((to) => {
        if (to.path === '/user/manage/article/list') {
          removeGuard()
          resolve()
        }
      })
    })
    router.back()
    await restored
    await nextTick()
    expect(router.currentRoute.value.path).toBe('/user/manage/article/list')
    expect(wrapper.get('.account-module-link-active').text()).toContain('内容')
    expect(wrapper.get('.account-local-navigation__link--active').text()).toContain('文章')
  })

  it('keeps mobile module and local navigation in one panel with 44px-class controls', async () => {
    const { wrapper } = await mountPanel('/user/manage/moderation/anonymous-risk', 'mobile')

    expect(wrapper.attributes('data-variant')).toBe('mobile')
    expect(wrapper.get('[aria-label="管理一级模块"]').exists()).toBe(true)
    expect(wrapper.get('[aria-label="互动局部导航"]').exists()).toBe(true)
    expect(wrapper.get('.account-local-navigation__link--active').text()).toContain('匿名风险')
  })
})
