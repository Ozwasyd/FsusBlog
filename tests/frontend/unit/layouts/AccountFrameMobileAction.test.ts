// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it, vi } from 'vitest'
import { ElButton } from '@ozwasyd/element-plus'
import AccountFrameMobileAction from '@/layouts/AccountFrameMobileAction.vue'

const drawerVisible = ref(false)

vi.mock('@/layouts/accountFrameContext', () => ({
  useAccountFrameDrawerState: (): Ref<boolean> => drawerVisible
}))

vi.mock('@/layouts/accountWorkspaceContext', () => ({
  useAccountWorkspaceContext: () =>
    ref({
      area: 'self',
      areaMeta: { label: '账户中心' },
      canManage: false
    })
}))

vi.mock('@/layouts/accountNav', () => ({
  getAccountNavGroups: () => [
    {
      id: 'identity',
      label: '身份',
      items: [
        { id: 'profile', label: '个人资料', to: '/user/profile' },
        { id: 'security', label: '安全', to: '/user/security' }
      ]
    }
  ],
  isAccountNavGroupActive: (group: { id: string }, path: string) =>
    group.id === 'identity' && path.startsWith('/user/'),
  isAccountNavItemActive: (item: { to: string }, path: string) => path === item.to
}))

const mountAction = async (path = '/user/profile') => {
  drawerVisible.value = false
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => h('div') } }]
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AccountFrameMobileAction, {
    global: {
      plugins: [router],
      stubs: {
        ElIcon: true
      }
    }
  })
  return { router, wrapper }
}

describe('AccountFrameMobileAction', () => {
  it('renders exactly one FsusUI Button trigger with product aria wiring', async () => {
    const { wrapper } = await mountAction('/user/profile')
    const buttons = wrapper.findAllComponents(ElButton)
    expect(buttons).toHaveLength(1)
    const trigger = buttons[0]!
    expect(trigger.element.tagName).toBe('BUTTON')
    expect(trigger.classes()).toContain('el-button')
    expect(trigger.classes()).toContain('account-mobile-drawer-trigger')
    expect(wrapper.findAll('button')).toHaveLength(1)
    expect(trigger.attributes('aria-controls')).toBe('account-mobile-drawer')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('aria-label')).toContain('打开账户导航')
    expect(trigger.attributes('aria-label')).toContain('身份')
    expect(trigger.attributes('aria-label')).toContain('个人资料')
    // No nested native clickable wrapper
    expect(trigger.element.querySelector('button')).toBeNull()
  })

  it('opens the drawer once via Enter/Space/click and keeps aria-expanded synchronized', async () => {
    const { wrapper } = await mountAction()
    const trigger = wrapper.get('button.account-mobile-drawer-trigger')

    await trigger.trigger('click')
    await nextTick()
    expect(drawerVisible.value).toBe(true)
    expect(trigger.attributes('aria-expanded')).toBe('true')

    // Repeated activation while open must not create a second trigger or second native button
    await trigger.trigger('keydown', { key: 'Enter' })
    await trigger.trigger('keydown', { key: ' ' })
    expect(wrapper.findAll('button')).toHaveLength(1)
    expect(drawerVisible.value).toBe(true)
  })

  it('closes the drawer on route change and updates dynamic aria-label', async () => {
    const { router, wrapper } = await mountAction('/user/profile')
    const trigger = wrapper.get('button.account-mobile-drawer-trigger')
    drawerVisible.value = true
    await nextTick()
    expect(trigger.attributes('aria-expanded')).toBe('true')

    await router.push('/user/security')
    await flushPromises()
    await nextTick()
    expect(drawerVisible.value).toBe(false)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('aria-label')).toContain('安全')
  })
})
