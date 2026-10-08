// @vitest-environment happy-dom

import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as localeApi from '@/locales'

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
    expect(runtime.retryLocale.value).toBe('ru-RU')
    expect(runtime.pendingLocale.value).toBeNull()
    expect(runtime.menuOpen.value).toBe(false)
    runtime.handleOpenChange(true)
    expect(runtime.menuOpen.value).toBe(true)
  })
  it('ignores an older rejection while the newest selection is pending', async () => {
    let rejectOld!: (error: Error) => void
    let finishNew!: () => void
    const oldRequest = new Promise<never>((_, reject) => { rejectOld = reject })
    const newRequest = new Promise<'ru-RU'>((resolve) => { finishNew = () => resolve('ru-RU') })
    const request = vi.spyOn(localeApi, 'requestLocalePreference')
      .mockImplementationOnce(() => oldRequest)
      .mockImplementationOnce(() => newRequest)
    const runtime = useLocaleSelectorRuntime()
    runtime.handleOpenChange(true)
    const oldSelection = runtime.commitFixedLocale('de-DE')
    const newSelection = runtime.commitFixedLocale('ru-RU')
    rejectOld(new Error('stale failure'))
    await oldSelection
    expect(runtime.errorMessage.value).toBeNull()
    expect(runtime.retryLocale.value).toBeNull()
    expect(runtime.menuOpen.value).toBe(true)
    finishNew()
    await newSelection
    expect(runtime.menuOpen.value).toBe(false)
    request.mockRestore()
  })

  it('ignores an older success while the newest selection remains pending', async () => {
    let finishOld!: () => void
    let rejectNew!: (error: Error) => void
    const oldRequest = new Promise<'de-DE'>((resolve) => { finishOld = () => resolve('de-DE') })
    const newRequest = new Promise<never>((_, reject) => { rejectNew = reject })
    const request = vi.spyOn(localeApi, 'requestLocalePreference')
      .mockImplementationOnce(() => oldRequest)
      .mockImplementationOnce(() => newRequest)
    const runtime = useLocaleSelectorRuntime()
    runtime.handleOpenChange(true)
    const oldSelection = runtime.commitFixedLocale('de-DE')
    const newSelection = runtime.commitFixedLocale('ru-RU')
    finishOld()
    await oldSelection
    expect(runtime.menuOpen.value).toBe(true)
    rejectNew(new Error('latest failure'))
    await newSelection
    expect(runtime.retryLocale.value).toBe('ru-RU')
    expect(runtime.errorMessage.value).toContain('Русский')
    expect(runtime.activeLocale.value).toBe('ja-JP')
    request.mockRestore()
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
          transition: false,
          Check: IconStub,
          Loading: IconStub,
          Refresh: IconStub
        }
      }
    })
    const root = wrapper.get('[data-locale-selector-runtime-adapter]')
    expect(root.attributes('data-active-locale')).toBe('ja-JP')

    await wrapper.get('[data-locale-selector-trigger]').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('[data-locale-selector-trigger]').attributes('aria-expanded')).toBe('true'))
    const codes = [...document.querySelectorAll('[data-locale-selector-item]')]
      .map((node) => node.getAttribute('data-locale-code'))
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
          transition: false,
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
