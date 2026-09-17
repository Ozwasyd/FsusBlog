// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PublicAuthLayout from '@/layouts/PublicAuthLayout.vue'
import {
  activateLocaleRuntime,
  activeLocale,
  requestLocalePreference,
  resetLocaleRuntimeForTests
} from '@/locales'
import { useI18nText } from '@/composables/useI18nText'

vi.mock('@/store/site', () => ({
  useSiteStore: () => ({
    siteInfo: {
      title: "Fsu's Blog",
      siteLogoUrl: '',
      siteLogoDarkUrl: '',
      siteWordmarkUrl: '',
      loginLogoUrl: '',
      loginIconUrl: ''
    }
  })
}))

const ThemeModeToggleStub = defineComponent({
  props: {
    visibility: String,
    variant: String
  },
  template: '<button type="button" data-theme-mode-toggle :data-visibility="visibility">theme</button>'
})

const LocaleSelectorRuntimeAdapterStub = defineComponent({
  props: {
    compact: Boolean
  },
  template:
    '<div data-locale-selector-runtime-adapter :data-compact="compact ? \'true\' : \'false\'"></div>'
})

const AuthFormStub = defineComponent({
  name: 'AuthFormStub',
  setup() {
    const password = ref('keep-me-secret')
    const rememberMe = ref(true)
    const mountCount = ref(0)
    mountCount.value += 1
    return () =>
      h('form', { 'data-auth-form': 'true' }, [
        h('input', {
          'data-password-field': 'true',
          value: password.value,
          onInput: (event: Event) => {
            password.value = (event.target as HTMLInputElement).value
          }
        }),
        h('input', {
          type: 'checkbox',
          'data-remember-me': 'true',
          checked: rememberMe.value,
          onChange: (event: Event) => {
            rememberMe.value = (event.target as HTMLInputElement).checked
          }
        }),
        h('span', { 'data-mount-count': String(mountCount.value) }, String(mountCount.value))
      ])
  }
})

const RootStub = defineComponent({
  name: 'PublicAuthLayoutTestRoot',
  template: '<router-view />'
})

async function mountAuthLayout(routeName: 'Login' | 'Register' | 'Recover' = 'Login') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: PublicAuthLayout,
        children: [
          { path: 'login', name: 'Login', component: AuthFormStub },
          { path: 'register', name: 'Register', component: AuthFormStub },
          { path: 'recover', name: 'Recover', component: AuthFormStub }
        ]
      }
    ]
  })
  const path =
    routeName === 'Register' ? '/register' : routeName === 'Recover' ? '/recover' : '/login'
  await router.push(path)
  await router.isReady()

  const wrapper = mount(RootStub, {
    attachTo: document.body,
    global: {
      plugins: [router],
      stubs: {
        ThemeModeToggle: ThemeModeToggleStub,
        LocaleSelectorRuntimeAdapter: LocaleSelectorRuntimeAdapterStub
      }
    }
  })
  return { wrapper, router }
}

describe('PublicAuthLayout locale selector integration', () => {
  beforeEach(async () => {
    resetLocaleRuntimeForTests()
    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public', 'auth', 'errors'])
  })

  afterEach(() => {
    resetLocaleRuntimeForTests()
    document.body.innerHTML = ''
  })

  it.each(['Login', 'Register', 'Recover'] as const)(
    'places the shared ten-language adapter on desktop and mobile for %s',
    async (routeName) => {
      const { wrapper } = await mountAuthLayout(routeName)
      const adapters = wrapper.findAll('[data-locale-selector-runtime-adapter]')
      expect(adapters).toHaveLength(2)
      expect(adapters.some((node) => node.attributes('data-compact') === 'true')).toBe(true)
      expect(adapters.some((node) => node.attributes('data-compact') !== 'true')).toBe(true)
      expect(wrapper.find('.auth-header__actions [data-locale-selector-runtime-adapter]').exists()).toBe(
        true
      )
      expect(
        wrapper.find('.auth-header__mobile-actions [data-locale-selector-runtime-adapter]').exists()
      ).toBe(true)
      expect(wrapper.find('[data-auth-form]').exists()).toBe(true)
      wrapper.unmount()
    }
  )

  it('keeps auth form values and router-view identity across a locale preference switch', async () => {
    const preferenceCalls: Array<Readonly<{ mode: string; locale?: string }>> = []
    resetLocaleRuntimeForTests({
      preferenceCommitPort: {
        commit: async (command) => {
          preferenceCalls.push(
            command.mode === 'fixed'
              ? { mode: command.mode, locale: command.locale }
              : { mode: command.mode }
          )
          const locale = command.mode === 'fixed' ? command.locale : 'zh-CN'
          return Object.freeze({
            mode: command.mode,
            fixedLocale: command.mode === 'fixed' ? command.locale : null,
            effectiveLocale: locale,
            revision: preferenceCalls.length
          })
        }
      }
    })
    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public', 'auth', 'errors'])

    const { wrapper } = await mountAuthLayout('Login')
    const form = wrapper.get('[data-auth-form]')
    const password = wrapper.get('[data-password-field]')
    const remember = wrapper.get('[data-remember-me]')
    const mountCountBefore = wrapper.get('[data-mount-count]').text()

    expect((password.element as HTMLInputElement).value).toBe('keep-me-secret')
    expect((remember.element as HTMLInputElement).checked).toBe(true)

    await requestLocalePreference({ mode: 'fixed', locale: 'ja-JP' })
    await flushPromises()
    await nextTick()

    expect(activeLocale.value).toBe('ja-JP')
    expect(preferenceCalls).toEqual([{ mode: 'fixed', locale: 'ja-JP' }])
    expect(wrapper.get('[data-auth-form]').element).toBe(form.element)
    expect(wrapper.get('[data-mount-count]').text()).toBe(mountCountBefore)
    expect((wrapper.get('[data-password-field]').element as HTMLInputElement).value).toBe(
      'keep-me-secret'
    )
    expect((wrapper.get('[data-remember-me]').element as HTMLInputElement).checked).toBe(true)

    const { messages } = useI18nText()
    expect(wrapper.get('.auth-header-action').text()).toBe(messages.value.common.routeTitles.register)

    wrapper.unmount()
  })

  it('keeps auth form state when locale preference commit fails', async () => {
    resetLocaleRuntimeForTests({
      preferenceCommitPort: {
        commit: async () => {
          throw new Error('locale_preference_revision_conflict')
        }
      }
    })
    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public', 'auth', 'errors'])

    const { wrapper } = await mountAuthLayout('Recover')
    const previous = activeLocale.value
    const mountCountBefore = wrapper.get('[data-mount-count]').text()

    await expect(requestLocalePreference({ mode: 'fixed', locale: 'de-DE' })).rejects.toThrow()
    await flushPromises()
    await nextTick()

    expect(activeLocale.value).toBe(previous)
    expect(wrapper.get('[data-mount-count]').text()).toBe(mountCountBefore)
    expect((wrapper.get('[data-password-field]').element as HTMLInputElement).value).toBe(
      'keep-me-secret'
    )

    wrapper.unmount()
  })
})
