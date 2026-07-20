// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LOCALE,
  LOCALE_PREFERENCE_STORAGE_KEY,
  formatDate,
  formatNumber,
  initializeLocaleRuntime,
  locale,
  resetLocaleRuntimeForTests,
  setLocale,
  translate,
  translateUnsafe
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

  it('keeps the server-compatible Chinese default until client initialization', () => {
    localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, 'en-US')
    expect(locale.value).toBe(DEFAULT_LOCALE)
    expect(translate('common.routeTitles.login')).toBe('登录')

    initializeLocaleRuntime()

    expect(locale.value).toBe('en-US')
    expect(document.documentElement.lang).toBe('en-US')
    expect(document.querySelector('meta[property="og:locale"]')?.getAttribute('content')).toBe('en_US')
  })

  it('persists a supported preference and translates typed keys', () => {
    setLocale('en-US')
    expect(localStorage.getItem(LOCALE_PREFERENCE_STORAGE_KEY)).toBe('en-US')
    expect(translate('article.metadata.longRead')).toBe('Long read')
  })

  it('falls back to the key without crashing when both dictionaries miss a runtime key', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setLocale('en-US')
    expect(translateUnsafe('future.missing.key')).toBe('future.missing.key')
    expect(warning).toHaveBeenCalledOnce()
  })

  it('formats dates and numbers through the active Intl locale', () => {
    setLocale('en-US')
    expect(formatNumber(12345)).toBe(new Intl.NumberFormat('en-US').format(12345))
    expect(formatDate('2026-07-20T00:00:00Z', { year: 'numeric' }))
      .toBe(new Intl.DateTimeFormat('en-US', { year: 'numeric' }).format(new Date('2026-07-20T00:00:00Z')))
  })
})
