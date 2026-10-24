// @vitest-environment happy-dom

import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'

import LocaleSelector from '@/components/ui/LocaleSelector.vue'
import type { LocaleSelectorItem } from '@/components/ui/localeSelectorTypes'
import { projectLocaleSelectorItems } from '../../fixtures/localeSelectorItems'
import { ENABLED_LOCALES } from '@/locales'

const IconStub = defineComponent({
  template: '<svg data-icon-stub="true" aria-hidden="true"></svg>'
})

function mountSelector(
  props: {
    items?: readonly LocaleSelectorItem[]
    activeLocale?: string
    pendingLocale?: string | null
    open?: boolean
    disabled?: boolean
    errorMessage?: string | null
    compact?: boolean
  } = {},
  attach = false
): VueWrapper<InstanceType<typeof LocaleSelector>> {
  const activeLocale = props.activeLocale ?? 'zh-CN'
  return mount(LocaleSelector, {
    props: {
      items: props.items ?? projectLocaleSelectorItems(activeLocale),
      activeLocale,
      pendingLocale: props.pendingLocale ?? null,
      open: props.open,
      disabled: props.disabled ?? false,
      errorMessage: props.errorMessage ?? null,
      compact: props.compact ?? false
    },
    attachTo: attach ? document.body : undefined,
    global: {
      stubs: {
        Check: IconStub,
        Loading: IconStub,
        Refresh: IconStub
      }
    }
  })
}

async function openWithKeyboard(wrapper: VueWrapper): Promise<void> {
  const trigger = wrapper.get('[data-locale-selector-trigger]')
  await trigger.trigger('keydown', { key: 'Enter' })
  await nextTick()
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('LocaleSelector presentational contract', () => {
  it('is driven only by props and projects ten catalog items without hardcoding', () => {
    const items = projectLocaleSelectorItems('ja-JP')
    const wrapper = mountSelector({ items, activeLocale: 'ja-JP' })
    expect(items).toHaveLength(ENABLED_LOCALES.length)
    expect(items.map((item) => item.code)).toEqual(ENABLED_LOCALES.map((locale) => locale.code))
    // Native hidden state keeps every projected item in the DOM without
    // depending on a CSS chunk or creating an inline style rejected by CSP.
    expect(wrapper.findAll('[data-locale-selector-item]')).toHaveLength(ENABLED_LOCALES.length)
    expect(wrapper.get('[data-locale-selector-trigger]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('[data-locale-selector-menu]').attributes()).toHaveProperty('hidden')
    expect(wrapper.props('items')).toEqual(items)
    expect(wrapper.get('[data-locale-selector-trigger]').text()).not.toMatch(/\bAa\b/)
    expect(wrapper.get('[data-locale-selector-trigger]').text()).not.toContain('中/EN')
    wrapper.unmount()
  })

  it('desktop trigger shows globe affordance and current nativeName', async () => {
    const wrapper = mountSelector({ activeLocale: 'es-419', compact: false })
    await openWithKeyboard(wrapper)
    expect(wrapper.get('[data-locale-selector-menu]').attributes()).not.toHaveProperty('hidden')
    expect(wrapper.get('[data-locale-selector-trigger]').text()).toContain('Español (Latinoamérica)')
    expect(wrapper.find('.locale-selector__globe-icon').exists()).toBe(true)
    expect(wrapper.get('[data-locale-selector-trigger]').text()).not.toMatch(/\bAa\b/)
    wrapper.unmount()
  })

  it('compact trigger shows globe and locale code, never Aa', () => {
    const wrapper = mountSelector({ activeLocale: 'pt-BR', compact: true })
    const trigger = wrapper.get('[data-locale-selector-trigger]')
    expect(trigger.text()).toContain('pt-BR')
    expect(trigger.text()).not.toMatch(/\bAa\b/)
    expect(wrapper.find('.locale-selector__globe-icon').exists()).toBe(true)
    wrapper.unmount()
  })

  it('renders every projected item native name including long labels', async () => {
    const wrapper = mountSelector({ activeLocale: 'zh-CN' })
    await openWithKeyboard(wrapper)
    const menuText = wrapper.get('[data-locale-selector-menu]').text()
    expect(menuText).toContain('Español (Latinoamérica)')
    expect(menuText).toContain('Português (Brasil)')
    expect(menuText).toContain('繁體中文')
    expect(menuText).toContain('Spanish (Latin America)')
    expect(menuText).toContain('Portuguese (Brazil)')
    expect(menuText).toContain('Traditional Chinese')
    wrapper.unmount()
  })

  it('marks the selected item with check and aria-current semantics', async () => {
    const wrapper = mountSelector({ activeLocale: 'ko-KR' })
    await openWithKeyboard(wrapper)
    const selected = wrapper.get('[data-locale-code="ko-KR"]')
    expect(selected.attributes('aria-checked')).toBe('true')
    expect(selected.attributes('aria-current')).toBe('true')
    expect(selected.attributes('data-selected')).toBe('true')
    expect(selected.find('[data-locale-selector-item-check]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows local pending progress on the pending item only', async () => {
    const wrapper = mountSelector({
      activeLocale: 'zh-CN',
      pendingLocale: 'de-DE',
      open: true
    })
    await nextTick()
    expect(wrapper.find('[data-locale-selector-trigger-pending]').exists()).toBe(true)
    expect(wrapper.get('[data-locale-code="de-DE"]').attributes('data-pending')).toBe('true')
    expect(wrapper.get('[data-locale-code="de-DE"]').find('[data-locale-selector-item-pending]').exists()).toBe(true)
    expect(wrapper.get('[data-locale-code="zh-CN"]').find('[data-locale-selector-item-pending]').exists()).toBe(false)
    expect(wrapper.find('[data-locale-selector]').classes()).not.toContain('locale-selector--disabled')
    wrapper.unmount()
  })

  it('keeps error visible with retry and emits retry for the failed target', async () => {
    const wrapper = mountSelector({
      activeLocale: 'zh-CN',
      pendingLocale: 'fr-FR',
      errorMessage: 'Locale switch failed',
      open: true
    })
    await nextTick()
    const error = wrapper.get('[data-locale-selector-error]')
    expect(error.text()).toContain('Locale switch failed')
    await wrapper.get('[data-locale-selector-retry]').trigger('click')
    expect(wrapper.emitted('retry')?.[0]).toEqual(['fr-FR'])
    wrapper.unmount()
  })

  it('emits select for a non-selected item and for a pending target again', async () => {
    const wrapper = mountSelector({
      activeLocale: 'zh-CN',
      pendingLocale: 'ja-JP',
      open: true
    })
    await nextTick()
    await wrapper.get('[data-locale-code="ru-RU"]').trigger('click')
    await wrapper.get('[data-locale-code="ja-JP"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['ru-RU'], ['ja-JP']])
    wrapper.unmount()
  })

  it('emits select when Enter activates the already selected item', async () => {
    const wrapper = mountSelector({ activeLocale: 'en-US', open: true }, true)
    await nextTick()
    const selected = wrapper.get('[data-locale-code="en-US"]')
    await selected.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select')?.[0]).toEqual(['en-US'])
    wrapper.unmount()
  })

  it('honors item order from props and does not reorder to catalog default', async () => {
    const projected = projectLocaleSelectorItems('zh-CN')
    const reversed = [...projected].reverse().map((item, index, all) => ({
      ...item,
      selected: index === all.length - 1
    }))
    const wrapper = mountSelector({ items: reversed, activeLocale: 'zh-CN', open: true })
    await nextTick()
    const codes = wrapper.findAll('[data-locale-selector-item]').map((node) => node.attributes('data-locale-code'))
    expect(codes).toEqual(reversed.map((item) => item.code))
    expect(codes[0]).toBe('ru-RU')
    wrapper.unmount()
  })

  it('renders an eleventh injected locale when the caller fails the catalog gate', async () => {
    const items = [
      ...projectLocaleSelectorItems('zh-CN'),
      {
        code: 'xx-XX',
        nativeName: 'Extra Locale',
        englishName: 'Extra Locale',
        direction: 'ltr' as const,
        selected: false
      }
    ]
    const wrapper = mountSelector({ items, activeLocale: 'zh-CN', open: true })
    await nextTick()
    expect(wrapper.findAll('[data-locale-selector-item]')).toHaveLength(11)
    expect(wrapper.get('[data-locale-code="xx-XX"]').text()).toContain('Extra Locale')
    wrapper.unmount()
  })

  it('supports progressive-enhancement href on items while still emitting select', async () => {
    const items = projectLocaleSelectorItems('zh-CN', {
      hrefByCode: { 'en-US': '/?locale=en-US' }
    })
    const wrapper = mountSelector({ items, activeLocale: 'zh-CN', open: true })
    await nextTick()
    const link = wrapper.get('[data-locale-code="en-US"]')
    expect(link.element.tagName).toBe('A')
    expect(link.attributes('href')).toBe('/?locale=en-US')
    await link.trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['en-US'])
    wrapper.unmount()
  })

  it('opens with Enter/Space, moves with arrows/Home/End, and restores focus on Escape', async () => {
    const wrapper = mountSelector({ activeLocale: 'zh-CN' }, true)
    const trigger = wrapper.get('[data-locale-selector-trigger]').element as HTMLButtonElement
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await wrapper.get('[data-locale-selector-trigger]').trigger('keydown', { key: ' ' })
    await nextTick()
    expect(wrapper.emitted('open-change')?.at(-1)).toEqual([true])
    expect(wrapper.find('[data-locale-selector-menu]').isVisible()).toBe(true)

    const selected = wrapper.get('[data-locale-code="zh-CN"]').element as HTMLElement
    selected.focus()
    await wrapper.get('[data-locale-code="zh-CN"]').trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect((document.activeElement as HTMLElement | null)?.getAttribute('data-locale-code')).toBe('en-US')

    await wrapper.get('[data-locale-code="en-US"]').trigger('keydown', { key: 'End' })
    await nextTick()
    expect((document.activeElement as HTMLElement | null)?.getAttribute('data-locale-code')).toBe('ru-RU')

    await wrapper.get('[data-locale-code="ru-RU"]').trigger('keydown', { key: 'Home' })
    await nextTick()
    expect((document.activeElement as HTMLElement | null)?.getAttribute('data-locale-code')).toBe('zh-CN')

    await wrapper.get('[data-locale-code="zh-CN"]').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(wrapper.emitted('open-change')?.at(-1)).toEqual([false])
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })

  it('does not open when disabled and keeps the same items/event contract in compact mode', async () => {
    const items = projectLocaleSelectorItems('de-DE')
    const wrapper = mountSelector({
      items,
      activeLocale: 'de-DE',
      compact: true,
      disabled: true
    })
    await wrapper.get('[data-locale-selector-trigger]').trigger('click')
    expect(wrapper.emitted('open-change')).toBeUndefined()
    expect(wrapper.emitted('select')).toBeUndefined()

    await wrapper.setProps({ disabled: false, open: true })
    await nextTick()
    await wrapper.get('[data-locale-code="ja-JP"]').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['ja-JP'])
    expect(wrapper.props('items')).toEqual(items)
    wrapper.unmount()
  })

  it('keeps long native names fully present without ellipsis truncation styles', async () => {
    const wrapper = mountSelector({ activeLocale: 'es-419', open: true })
    await nextTick()
    const longItem = wrapper.get('[data-locale-code="es-419"]')
    const native = longItem.get('.locale-selector__item-native')
    expect(native.text()).toBe('Español (Latinoamérica)')
    const style = getComputedStyle(native.element)
    expect(style.textOverflow === '' || style.textOverflow === 'clip').toBe(true)
    expect(native.classes()).toContain('locale-selector__item-native')
    // Menu max width is viewport-bounded for 320px shells.
    const menu = wrapper.get('[data-locale-selector-menu]').element as HTMLElement
    expect(menu.className).toContain('locale-selector__menu')
    wrapper.unmount()
  })

  it('keeps error visible near the trigger when the menu is closed', () => {
    const wrapper = mountSelector({
      activeLocale: 'zh-CN',
      pendingLocale: 'ru-RU',
      errorMessage: 'Still failed',
      open: false
    })
    expect(wrapper.get('[data-locale-selector-error]').text()).toContain('Still failed')
    expect(wrapper.find('[data-locale-selector-retry]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('LocaleSelector source isolation', () => {
  it('component module source does not import runtime, router, storage, or API', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/ui/LocaleSelector.vue'),
      'utf8'
    )
    expect(source).not.toMatch(/@\/locales(?:\/|$|['"])/u)
    expect(source).not.toMatch(/requestLocale|localeRuntime|localeCatalog|ENABLED_LOCALES/u)
    expect(source).not.toMatch(/@\/router|vue-router|localStorage|sessionStorage|document\.cookie/u)
    expect(source).not.toMatch(/@\/api\/|@\/store\/|@\/services\/localePreference/u)
    expect(source).not.toMatch(/\bv-show\b/u)
    const deprecatedLocaleResiduePattern = [
      'Locale' + 'Toggle',
      'toggle' + 'Locale',
      'is' + 'English',
      'toggle' + 'Label',
      'locale' + 'Override'
    ].join('|')
    expect(source).not.toMatch(new RegExp(deprecatedLocaleResiduePattern, 'u'))
    expect(source).not.toMatch(/['"]Aa['"]|中\/EN/u)
    expect(source).not.toMatch(/flag|🏳️|🇨🇳|🇺🇸/iu)
  })
})
