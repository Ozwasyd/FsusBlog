// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import LocaleSelectorRuntimeAdapter from '@/components/i18n/LocaleSelectorRuntimeAdapter.vue'
import { projectLocaleSelectorItems } from '@/components/i18n/projectLocaleSelectorItems'
import { useLocaleSelectorRuntime } from '@/components/i18n/useLocaleSelectorRuntime'
import {
  activateLocaleRuntime,
  activeLocale,
  ENABLED_LOCALES,
  resetLocaleRuntimeForTests
} from '@/locales'

const IconStub = defineComponent({
  template: '<svg data-icon-stub="true" aria-hidden="true"></svg>'
})

describe('projectLocaleSelectorItems', () => {
  it('mirrors the catalog order and selection flags for AOT/client identity', () => {
    const items = projectLocaleSelectorItems('ko-KR')
    expect(items.map((item) => item.code)).toEqual(ENABLED_LOCALES.map((locale) => locale.code))
    expect(items.find((item) => item.code === 'ko-KR')?.selected).toBe(true)
    expect(items.filter((item) => item.selected)).toHaveLength(1)
    expect(items.map((item) => item.nativeName)).toEqual(
      ENABLED_LOCALES.map((locale) => locale.nativeName)
    )
  })
})

describe('useLocaleSelectorRuntime', () => {
  beforeEach(async () => {
    resetLocaleRuntimeForTests()
    await activateLocaleRuntime('ja-JP', ['common', 'layout', 'public'])
  })

  afterEach(() => {
    resetLocaleRuntimeForTests()
  })

  it('submits fixed preference through the runtime transaction only', async () => {
    const preferenceCalls: Array<Readonly<{ mode: string; locale?: string }>> = []
    resetLocaleRuntimeForTests({
      preferenceCommitPort: {
        commit: async (command) => {
          preferenceCalls.push(
            command.mode === 'fixed'
              ? { mode: command.mode, locale: command.locale }
              : { mode: command.mode }
          )
          const locale = command.mode === 'fixed' ? command.locale : 'ja-JP'
          return Object.freeze({
            mode: command.mode,
            fixedLocale: command.mode === 'fixed' ? command.locale : null,
            effectiveLocale: locale,
            revision: preferenceCalls.length
          })
        }
      }
    })
    await activateLocaleRuntime('ja-JP', ['common', 'layout', 'public'])

    const runtime = useLocaleSelectorRuntime()
    expect(runtime.items.value.map((item) => item.code)).toEqual(
      ENABLED_LOCALES.map((locale) => locale.code)
    )
    expect(runtime.activeLocale.value).toBe('ja-JP')

    await runtime.commitFixedLocale('de-DE')
    await flushPromises()

    expect(preferenceCalls).toEqual([{ mode: 'fixed', locale: 'de-DE' }])
    expect(activeLocale.value).toBe('de-DE')
    expect(runtime.activeLocale.value).toBe('de-DE')
    expect(runtime.errorMessage.value).toBeNull()
  })

  it('keeps the previous active locale and surfaces error state when the transaction fails', async () => {
    resetLocaleRuntimeForTests({
      preferenceCommitPort: {
        commit: async () => {
          throw new Error('locale_preference_unavailable')
        }
      }
    })
    await activateLocaleRuntime('ja-JP', ['common', 'layout', 'public'])

    const runtime = useLocaleSelectorRuntime()
    const previous = activeLocale.value
    await runtime.commitFixedLocale('ru-RU')
    await flushPromises()

    expect(activeLocale.value).toBe(previous)
    expect(runtime.errorMessage.value).toContain('Русский')
    expect(runtime.menuOpen.value).toBe(false)
    runtime.handleOpenChange(true)
    expect(runtime.menuOpen.value).toBe(true)
  })
})

describe('LocaleSelectorRuntimeAdapter', () => {
  beforeEach(async () => {
    resetLocaleRuntimeForTests()
    await activateLocaleRuntime('ja-JP', ['common', 'layout', 'public'])
  })

  afterEach(() => {
    resetLocaleRuntimeForTests()
    document.body.innerHTML = ''
  })

  it('projects the full catalog as selector items without hardcoding a bilingual list', async () => {
    const wrapper = mount(LocaleSelectorRuntimeAdapter, {
      attachTo: document.body,
      global: {
        stubs: {
          Check: IconStub,
          Loading: IconStub,
          Refresh: IconStub
        }
      }
    })
    const root = wrapper.get('[data-locale-selector-runtime-adapter]')
    expect(root.attributes('data-active-locale')).toBe('ja-JP')

    const codes = wrapper
      .findAll('[data-locale-selector-item]')
      .map((node) => node.attributes('data-locale-code'))
    expect(codes).toEqual(ENABLED_LOCALES.map((locale) => locale.code))
    expect(codes).toHaveLength(ENABLED_LOCALES.length)
    expect(codes).not.toEqual(['zh-CN', 'en-US'])
    expect(wrapper.get('[data-locale-selector-trigger]').text()).toContain('日本語')
    wrapper.unmount()
  })

  it('compact mode keeps a short trigger identity from the catalog code', async () => {
    const wrapper = mount(LocaleSelectorRuntimeAdapter, {
      props: { compact: true },
      attachTo: document.body,
      global: {
        stubs: {
          Check: IconStub,
          Loading: IconStub,
          Refresh: IconStub
        }
      }
    })
    expect(wrapper.get('[data-locale-selector-runtime-adapter]').attributes('data-compact'))
      .toBe('true')
    expect(wrapper.get('[data-locale-selector-trigger]').text()).toContain('ja-JP')
    wrapper.unmount()
  })
})

describe('LocaleSelectorRuntimeAdapter source isolation', () => {
  it('does not know Public/Auth/Account routes or host layout chrome', () => {
    const adapter = readFileSync(
      resolve(process.cwd(), 'src/components/i18n/LocaleSelectorRuntimeAdapter.vue'),
      'utf8'
    )
    const composable = readFileSync(
      resolve(process.cwd(), 'src/components/i18n/useLocaleSelectorRuntime.ts'),
      'utf8'
    )
    // Split retired symbols so this test file itself does not reintroduce them.
    const retired = [
      'Locale' + 'Toggle',
      'locale' + 'Override',
      'locale' + 'RuntimeReady',
      'get' + 'LocaleMessages',
      'initialize' + 'LocaleRuntime'
    ]
    for (const source of [adapter, composable]) {
      expect(source).not.toMatch(/PublicBlogLayoutShell|PublicAuthLayout|AccountLayout|vue-router|@\/router/u)
      for (const symbol of retired) {
        expect(source.includes(symbol)).toBe(false)
      }
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/u)
    }
    expect(composable).toMatch(/requestLocalePreference/u)
    expect(composable).toMatch(/projectLocaleSelectorItems/u)
  })
})

describe('PublicBlogLayoutShell locale entry cutover', () => {
  it('uses only LocaleSelectorRuntimeAdapter and erases hydration-era locale switches', () => {
    const shell = readFileSync(
      resolve(process.cwd(), 'src/components/public/PublicBlogLayoutShell.vue'),
      'utf8'
    )
    expect(shell).toMatch(/LocaleSelectorRuntimeAdapter/u)
    expect(shell.match(/LocaleSelectorRuntimeAdapter/gu)?.length).toBeGreaterThanOrEqual(2)
    const retired = [
      'Locale' + 'Toggle',
      'locale' + 'Override',
      'locale' + 'RuntimeReady',
      'get' + 'LocaleMessages',
      'initialize' + 'LocaleRuntime'
    ]
    for (const symbol of retired) {
      expect(shell.includes(symbol)).toBe(false)
    }
    expect(shell).not.toMatch(/\brequestLocale\b|requestLocalePreference|localeRuntimeState|ENABLED_LOCALES/u)
    expect(shell).not.toMatch(/from\s+['"]@\/locales\/runtime/u)
    expect(shell).not.toMatch(/from\s+['"]@\/services\/localePreference/u)
    expect(shell).not.toMatch(/from\s+['"]@\/locales\/localeDomainBundleStore/u)
  })
})

describe('AccountLayout locale entry cutover', () => {
  it('uses only LocaleSelectorRuntimeAdapter in shared account/admin chrome', () => {
    const layout = readFileSync(
      resolve(process.cwd(), 'src/layouts/AccountLayout.vue'),
      'utf8'
    )
    const shellCss = readFileSync(
      resolve(process.cwd(), 'src/assets/account-shell-base.css'),
      'utf8'
    )
    const nav = readFileSync(
      resolve(process.cwd(), 'src/layouts/accountNav.ts'),
      'utf8'
    )

    expect(layout).toMatch(/LocaleSelectorRuntimeAdapter/u)
    expect(layout.match(/LocaleSelectorRuntimeAdapter/gu)?.length).toBeGreaterThanOrEqual(2)
    expect(layout).toMatch(/<LocaleSelectorRuntimeAdapter compact \/>/u)
    const retired = [
      'Locale' + 'PreferenceHeaderSelector',
      'Locale' + 'Toggle',
      'initialize' + 'LocaleRuntime'
    ]
    for (const symbol of retired) {
      expect(layout.includes(symbol)).toBe(false)
    }
    expect(layout).not.toMatch(/\brequestLocale\b|requestLocalePreference|localeRuntimeState|ENABLED_LOCALES/u)
    expect(layout).not.toMatch(/from\s+['"]@\/locales(?:\/runtime)?['"]/u)
    expect(layout).not.toMatch(/from\s+['"]@\/services\/localePreference/u)
    expect(layout).not.toMatch(/from\s+['"]@\/locales\/localeDomainBundleStore/u)
    expect(layout).not.toMatch(/from\s+['"]@\/locales\/localeCatalog/u)
    expect(shellCss).toMatch(/\.account-site-header__actions \.locale-selector__trigger/u)
    expect(nav).toMatch(/\/user\/preferences\/language/u)
    expect(nav).toMatch(/languageAndRegion/u)
  })
})
