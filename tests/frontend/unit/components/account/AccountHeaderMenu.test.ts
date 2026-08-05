// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import {
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  ref,
  type InjectionKey
} from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { ElButton } from '@ozwasyd/element-plus'
import AccountHeaderMenu from '@/components/account/AccountHeaderMenu.vue'

type CommandHandler = (command: unknown) => void
const commandKey: InjectionKey<CommandHandler> = Symbol('account-menu-command')

const ElDropdownStub = defineComponent({
  emits: ['command', 'visible-change'],
  setup(_, { emit, expose, slots }) {
    const visible = ref(false)
    provide(commandKey, (command) => emit('command', command))
    const setVisible = async (value: boolean) => {
      visible.value = value
      emit('visible-change', value)
      await nextTick()
    }
    expose({ setVisible })
    return () => h('div', { class: 'account-menu-dropdown-contract' }, [
      slots.default?.(),
      visible.value ? slots.dropdown?.() : undefined
    ])
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
    return () => h('li', {
      role: 'menuitem',
      'aria-disabled': String(props.disabled),
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

const setMenuVisible = async (
  wrapper: Awaited<ReturnType<typeof mountMenu>>['wrapper'],
  visible: boolean
) => {
  const dropdown = wrapper.findComponent(ElDropdownStub)
  const exposed = (dropdown.vm.$ as unknown as {
    exposed: { setVisible: (value: boolean) => Promise<void> }
  }).exposed
  await exposed.setVisible(visible)
}

describe('AccountHeaderMenu', () => {
  it('renders one real FsusUI Button trigger and keeps visibility semantics synchronized', async () => {
    const { router, wrapper } = await mountMenu()
    const triggerButton = wrapper.findComponent(ElButton)
    const trigger = wrapper.get('[aria-label="打开账号菜单"]')

    expect(triggerButton.exists()).toBe(true)
    expect(triggerButton.element.tagName).toBe('BUTTON')
    expect(triggerButton.classes()).toContain('el-button')
    expect(triggerButton.props('size')).toBe('small')
    expect(wrapper.findAll('[aria-label="打开账号菜单"]')).toHaveLength(1)
    expect(trigger.element.querySelector('button')).toBeNull()
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)

    await setMenuVisible(wrapper, true)
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[role="menu"]').attributes('aria-label')).toBe('打开账号菜单')

    await setMenuVisible(wrapper, false)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)

    await setMenuVisible(wrapper, true)
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

  it('preserves menu order, authorization filtering and both route commands', async () => {
    const management = await mountMenu({
      canManage: true,
      currentArea: 'self'
    })
    await management.router.push('/user/identity')
    await setMenuVisible(management.wrapper, true)
    expect(
      management.wrapper.findAll('[data-command]').map((item) => item.attributes('data-command'))
    ).toEqual(['manage', 'guidelines', 'privacy', 'logout'])

    await management.wrapper.get('[data-command="manage"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(management.router.currentRoute.value.path).toBe('/user/manage')

    const { wrapper } = await mountMenu({
      canManage: false,
      currentArea: 'self'
    })
    await setMenuVisible(wrapper, true)

    expect(wrapper.find('[data-command="manage"]').exists()).toBe(false)
    expect(wrapper.get('[role="menu"]').text()).not.toContain('管理后台')
    expect(
      wrapper.findAll('[data-command]').map((item) => item.attributes('data-command'))
    ).toEqual(['guidelines', 'privacy', 'logout'])
  })

  it('rejects repeated logout dispatch while logout is already running', async () => {
    const { wrapper } = await mountMenu({ isLoggingOut: true })
    await setMenuVisible(wrapper, true)
    const logoutItem = wrapper
      .findAllComponents(ElDropdownItemStub)
      .find((item) => item.props('command') === 'logout')
    const logout = wrapper.get<HTMLElement>('[data-command="logout"]')

    expect(logoutItem?.props('disabled')).toBe(true)
    expect(logout.text()).toContain('登出中…')
    expect(logout.attributes('aria-disabled')).toBe('true')
    await logout.trigger('click')
    expect(wrapper.emitted('logout')).toBeUndefined()

    wrapper.findComponent(ElDropdownStub).vm.$emit('command', 'logout')
    await nextTick()
    expect(wrapper.emitted('logout')).toBeUndefined()
  })

  it('keeps normal and compact accessible names while selecting FsusUI touch density', async () => {
    const normal = await mountMenu()
    const normalTrigger = normal.wrapper.get('[aria-label="打开账号菜单"]')
    expect(normal.wrapper.findComponent(ElButton).props('size')).toBe('small')
    expect(normalTrigger.attributes('aria-label')).toBe('打开账号菜单')
    expect(normalTrigger.get('span').classes()).not.toContain('sr-only')
    expect(normalTrigger.text()).toContain('账号')

    const { wrapper } = await mountMenu({ compact: true })
    const trigger = wrapper.get('[aria-label="打开账号菜单"]')

    expect(wrapper.findComponent(ElButton).props('size')).toBe('default')
    expect(trigger.classes()).toContain('el-button')
    expect(trigger.attributes('aria-label')).toBe('打开账号菜单')
    expect(trigger.text()).toContain('账号')
    expect(trigger.get('span.sr-only').text()).toBe('账号')
    expect(wrapper.get('el-icon-stub').attributes('size')).toBe('18')
  })
})
