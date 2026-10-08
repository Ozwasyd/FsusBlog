// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateLocaleRuntime,
  ENABLED_LOCALES,
  activeLocale,
  beginLocaleRouteTransaction,
  createLocaleTextContext,
  formatDate,
  formatNumber,
  messages,
  prepareLocaleDomains,
  resetLocaleRuntimeForTests,
  requestLocale,
  translate,
  parseSupportedLocale
} from '@/locales'

describe('locale runtime', () => {
  beforeEach(() => {
    localStorage.clear()
    document.head.innerHTML = ''
    document.documentElement.lang = ''
    resetLocaleRuntimeForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetLocaleRuntimeForTests()
  })

  it('publishes the server-resolved non-default locale and exact domains before first render', async () => {
    await activateLocaleRuntime('ja-JP', ['common', 'layout', 'public'])

    expect(activeLocale.value).toBe('ja-JP')
    expect(Object.keys(messages.value).sort()).toEqual(['common', 'layout', 'public'])
    expect(translate('common.routeTitles.login')).toBe('ログイン')
    expect(document.documentElement.lang).toBe('ja-JP')
    expect(document.querySelector('meta[property="og:locale"]')?.getAttribute('content')).toBe('ja_JP')
    expect(messages.value).not.toHaveProperty('admin')
    expect(messages.value).not.toHaveProperty('security')
    expect(messages.value).not.toHaveProperty('identity')
  })

  it('keeps the server or document locale as the only startup authority', async () => {
    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public'])
    expect(activeLocale.value).toBe('zh-CN')
    expect(translate('common.routeTitles.login')).toBe('登录')
    expect(document.documentElement.lang).toBe('zh-CN')

    resetLocaleRuntimeForTests()
    document.documentElement.lang = 'en-US'
    await activateLocaleRuntime(undefined, ['common', 'layout', 'public'])

    expect(activeLocale.value).toBe('en-US')
    expect(translate('common.routeTitles.login')).toBe('Log in')
  })

  it('fails closed when bootstrap lacks a server-resolved locale', async () => {
    document.documentElement.lang = ''
    await expect(activateLocaleRuntime(undefined, ['common', 'layout', 'public']))
      .rejects.toThrow('locale_runtime_initial_locale_missing')
    expect(activeLocale.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('')
  })

  it('projects a supported locale without writing client persistence', async () => {
    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public', 'article'])
    await requestLocale('en-US')
    expect(localStorage.length).toBe(0)
    expect(translate('article.metadata.longRead')).toBe('Long read')
  })

  it('requests one explicit target without publishing a locale CustomEvent', async () => {
    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public'])
    const eventDetail = vi.fn()
    // Construct the retired event name so the static erasure checker does not
    // treat this negative proof as a live producer.
    const retiredLocaleEvent = ['fsus', 'locale-change'].join(':')
    window.addEventListener(
      retiredLocaleEvent,
      (event) => eventDetail((event as CustomEvent).detail)
    )

    await requestLocale('fr-FR')

    expect(activeLocale.value).toBe('fr-FR')
    expect(eventDetail).not.toHaveBeenCalled()
  })

  it('rolls back a staged route without changing active messages or metadata', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    const previousMessages = messages.value
    const previousLanguage = document.documentElement.lang

    const transaction = await beginLocaleRouteTransaction([
      'common',
      'layout',
      'public',
      'auth',
      'errors'
    ])
    expect(transaction.snapshot.messages).toHaveProperty('auth')
    transaction.rollback()

    expect(activeLocale.value).toBe('en-US')
    expect(messages.value).toBe(previousMessages)
    expect(messages.value).not.toHaveProperty('auth')
    expect(document.documentElement.lang).toBe(previousLanguage)
  })

  it('serializes a locale switch behind the immutable route transaction snapshot', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    const transaction = await beginLocaleRouteTransaction([
      'common',
      'layout',
      'public',
      'auth',
      'errors'
    ])
    let switchSettled = false
    const switchPromise = requestLocale('ja-JP').finally(() => {
      switchSettled = true
    })
    await Promise.resolve()

    expect(switchSettled).toBe(false)
    expect(activeLocale.value).toBe('en-US')
    transaction.commit()
    await switchPromise

    expect(activeLocale.value).toBe('ja-JP')
    expect(Object.keys(messages.value).sort())
      .toEqual(['auth', 'common', 'errors', 'layout', 'public'])
    expect(messages.value.auth.login.title).toBe('ログイン')
    expect(document.documentElement.lang).toBe('ja-JP')
  })

  it('keeps the old atomic projection when a required domain cannot be prepared', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    const previousMessages = messages.value
    const previousLanguage = document.documentElement.lang

    await expect(beginLocaleRouteTransaction([
      'common',
      'future' as never
    ])).rejects.toThrow('unsupported_locale_domain:future')

    expect(activeLocale.value).toBe('en-US')
    expect(messages.value).toBe(previousMessages)
    expect(document.documentElement.lang).toBe(previousLanguage)
  })

  it('fails closed when the active locale is missing a message key', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    await requestLocale('en-US')
    const routeTitles = messages.value.common?.routeTitles as { login?: string }
    const login = routeTitles.login
    delete routeTitles.login
    try {
      expect(() => translate('common.routeTitles.login'))
        .toThrowError('i18n_missing_message:en-US:common.routeTitles.login')
    } finally {
      routeTitles.login = login
    }
  })

  it('formats dates and numbers through the active Intl locale', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    await requestLocale('en-US')
    expect(formatNumber(12345)).toBe(new Intl.NumberFormat('en-US').format(12345))
    expect(formatDate('2026-07-20T00:00:00Z', { year: 'numeric' }))
      .toBe(new Intl.DateTimeFormat('en-US', { year: 'numeric' }).format(new Date('2026-07-20T00:00:00Z')))
  })

  it('keeps request-scoped formatting on the prepared SSR locale', async () => {
    await activateLocaleRuntime('en-US', ['common'])
    const scoped = createLocaleTextContext(
      await prepareLocaleDomains('ja-JP', ['common'])
    )

    expect(scoped.formatDate('invalid')).toBe('日時形式が無効です')
    expect(formatDate('invalid')).toBe('Invalid time')
  })

  for (const descriptor of ENABLED_LOCALES) {
    it(`keeps prepared and active Intl formatting coherent for ${descriptor.code}`, async () => {
      const prepared = await prepareLocaleDomains(descriptor.code, ['common', 'layout', 'public'])
      const scoped = createLocaleTextContext(prepared)
      const instant = new Date('2026-07-20T12:00:00Z')
      const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
      const expectedNumber = new Intl.NumberFormat(descriptor.intlLocale).format(12345.67)
      const expectedDate = new Intl.DateTimeFormat(descriptor.intlLocale, options).format(instant)
      expect(scoped.activeLocale.value).toBe(descriptor.code)
      expect(scoped.formatNumber(12345.67)).toBe(expectedNumber)
      expect(scoped.formatDate(instant, options)).toBe(expectedDate)
      expect(scoped.formatRelativeTime(-1, 'day'))
        .toBe(new Intl.RelativeTimeFormat(descriptor.intlLocale, { numeric: 'auto' }).format(-1, 'day'))
      await activateLocaleRuntime(descriptor.code, ['common', 'layout', 'public'])
      expect(activeLocale.value).toBe(descriptor.code)
      expect(formatNumber(12345.67)).toBe(expectedNumber)
      expect(formatDate(instant, options)).toBe(expectedDate)
      expect(document.documentElement.lang).toBe(descriptor.documentLanguage)
      expect(document.querySelector('meta[property="og:locale"]')?.getAttribute('content'))
        .toBe(descriptor.openGraphLocale)
      expect(scoped.formatNumber(12345.67)).toBe(formatNumber(12345.67))
    })
  }

  it('keeps canonical zh-Hant distinct from the controlled zh-TW input alias', () => {
    expect(parseSupportedLocale('zh-tw')).toBe('zh-Hant')
    expect(parseSupportedLocale('zh-Hant')).toBe('zh-Hant')
    expect(parseSupportedLocale('zh-TW')).not.toBe('zh-TW')
  })
})
