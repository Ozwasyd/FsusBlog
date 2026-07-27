// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LOCALE,
  LOCALE_PREFERENCE_STORAGE_KEY,
  formatDate,
  formatNumber,
  initializeLocaleRuntime,
  locale,
  prepareLocaleRuntime,
  resetLocaleRuntimeForTests,
  setLocale,
  translate,
  translateUnsafe,
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

  it('keeps the server render locale authoritative during client initialization', () => {
    localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, 'en-US')
    expect(locale.value).toBe(DEFAULT_LOCALE)
    expect(translate('common.routeTitles.login')).toBe('登录')

    initializeLocaleRuntime('zh-CN')

    expect(locale.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.querySelector('meta[property="og:locale"]')?.getAttribute('content')).toBe('zh_CN')
  })

  it('persists a supported preference and translates typed keys', () => {
    setLocale('en-US')
    expect(localStorage.getItem(LOCALE_PREFERENCE_STORAGE_KEY)).toBe('en-US')
    expect(translate('article.metadata.longRead')).toBe('Long read')
  })

  it('fails closed instead of rendering another language before its bundle is loaded', () => {
    initializeLocaleRuntime('ja-JP')

    expect(() => translate('public.shell.home')).toThrowError('i18n_bundle_not_loaded:ja-JP')
  })

  it('loads the negotiated domain bundle before Japanese first render', async () => {
    await prepareLocaleRuntime('ja-JP')

    expect(locale.value).toBe('ja-JP')
    expect(translate('public.shell.home')).toBe('ホーム')
    expect(formatNumber(12345)).toBe(new Intl.NumberFormat('ja-JP').format(12345))
  })

  it('fails closed when the active locale is missing a message key', () => {
    setLocale('en-US')
    expect(() => translateUnsafe('future.missing.key'))
      .toThrowError('i18n_missing_message:en-US:future.missing.key')
  })

  it('formats dates and numbers through the active Intl locale', () => {
    setLocale('en-US')
    expect(formatNumber(12345)).toBe(new Intl.NumberFormat('en-US').format(12345))
    expect(formatDate('2026-07-20T00:00:00Z', { year: 'numeric' }))
      .toBe(new Intl.DateTimeFormat('en-US', { year: 'numeric' }).format(new Date('2026-07-20T00:00:00Z')))
  })

  it('keeps canonical zh-Hant distinct from the controlled zh-TW input alias', () => {
    expect(parseSupportedLocale('zh-tw')).toBe('zh-Hant')
    expect(parseSupportedLocale('zh-Hant')).toBe('zh-Hant')
    expect(parseSupportedLocale('zh-TW')).not.toBe('zh-TW')
  })
})
