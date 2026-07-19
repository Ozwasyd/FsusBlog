// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import {
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  type InjectionKey
} from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it } from 'vitest'
import AccountHeaderMenu from '@/components/account/AccountHeaderMenu.vue'

type CommandHandler = (command: unknown) => void
const commandKey: InjectionKey<CommandHandler> = Symbol('account-menu-command')

const ElDropdownStub = defineComponent({
  emits: ['command', 'visible-change'],
  setup(_, { emit, slots }) {
    provide(commandKey, (command) => emit('command', command))
    return () => h('div', [slots.default?.(), slots.dropdown?.()])
  }
})

const ElDropdownMenuStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', { role: 'menu', 'aria-label': '打开账号菜单' }, slots.default?.())
  }
})

const ElDropdownItemStub = defineComponent({
  props: {
    command: { type: [String, Number, Object], required: true },
    disabled: { type: Boolean, default: false }
  },
  setup(props, { slots }) {
    const dispatch = inject(commandKey)!
    return () => h('button', {
      type: 'button',
      disabled: props.disabled,
      'data-command': String(props.command),
      onClick: () => {
        if (!props.disabled) dispatch(props.command)
      }
    }, slots.default?.())
  }
})

type MenuProps = {
  canManage: boolean
  compact?: boolean
  currentArea: 'self' | 'manage'
  isLoggingOut: boolean
}

const mountMenu = async (override: Partial<MenuProps> = {}) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => h('div') } }]
  })
  await router.push('/user/manage')
  await router.isReady()
  const props: MenuProps = {
    canManage: true,
    currentArea: 'manage',
    isLoggingOut: false,
    ...override
  }
  const wrapper = mount(AccountHeaderMenu, {
    props,
    global: {
      plugins: [router],
      stubs: {
        ElDropdown: ElDropdownStub,
        ElDropdownMenu: ElDropdownMenuStub,
        ElDropdownItem: ElDropdownItemStub,
        ElIcon: true
      }
    }
  })
  return { router, wrapper }
}

describe('AccountHeaderMenu', () => {
  it('moves account switching, policies and logout behind one accessible trigger', async () => {
    const { router, wrapper } = await mountMenu()

    expect(wrapper.get('[aria-label="打开账号菜单"]').attributes('aria-haspopup')).toBe('menu')
    expect(wrapper.get('[aria-label="打开账号菜单"]').attributes('aria-expanded')).toBe('false')
    wrapper.findComponent(ElDropdownStub).vm.$emit('visible-change', true)
    await nextTick()
    expect(wrapper.get('[aria-label="打开账号菜单"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[role="menu"]').attributes('aria-label')).toBe('打开账号菜单')
    expect(wrapper.get('[role="menu"]').text()).toContain('账户中心')
    expect(wrapper.get('[role="menu"]').text()).toContain('使用规范')
    expect(wrapper.get('[role="menu"]').text()).toContain('隐私政策')
    expect(wrapper.get('[role="menu"]').text()).toContain('登出')

    await wrapper.get('[data-command="guidelines"]').trigger('click')
    await wrapper.get('[data-command="privacy"]').trigger('click')
    await wrapper.get('[data-command="logout"]').trigger('click')
    expect(wrapper.emitted('open-policy')).toEqual([['guidelines'], ['privacy']])
    expect(wrapper.emitted('logout')).toHaveLength(1)

    await wrapper.get('[data-command="account"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(router.currentRoute.value.path).toBe('/user/identity')
  })

  it('hides the admin switch from an account without an active admin principal', async () => {
    const { wrapper } = await mountMenu({
      canManage: false,
      currentArea: 'self'
    })

    expect(wrapper.find('[data-command="manage"]').exists()).toBe(false)
    expect(wrapper.get('[role="menu"]').text()).not.toContain('管理后台')
    expect(wrapper.get('[data-command="guidelines"]').exists()).toBe(true)
    expect(wrapper.get('[data-command="privacy"]').exists()).toBe(true)
  })

  it('disables the logout command while logout is already running', async () => {
    const { wrapper } = await mountMenu({ isLoggingOut: true })
    const logout = wrapper.get<HTMLButtonElement>('[data-command="logout"]')

    expect(logout.text()).toContain('登出中…')
    expect(logout.element.disabled).toBe(true)
    await logout.trigger('click')
    expect(wrapper.emitted('logout')).toBeUndefined()
  })

  it('marks the icon-only mobile trigger for the default touch density', async () => {
    const { wrapper } = await mountMenu({ compact: true })
    const trigger = wrapper.get('[aria-label="打开账号菜单"]')

    expect(trigger.classes()).toContain('account-header-menu__trigger--touch')
    expect(trigger.text()).toContain('账号')
    expect(trigger.get('span').classes()).toContain('sr-only')
  })
})
