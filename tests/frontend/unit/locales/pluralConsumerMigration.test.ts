// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activateLocaleRuntime,
  getPluralRulesForLocale,
  requestLocale,
  resetLocaleRuntimeForTests,
  translatePlural
} from '@/locales'

describe('plural consumer migration (#1535)', () => {
  beforeEach(() => {
    localStorage.clear()
    document.head.innerHTML = ''
    document.documentElement.lang = ''
    resetLocaleRuntimeForTests()
  })

  afterEach(() => {
    resetLocaleRuntimeForTests()
  })

  it('covers en-US 0/1/2 and ru-RU 0/1/2/5/11/21/22/25 for every production plural key', async () => {
    const keys = [
      'public.archive.publishedCount',
      'identity.overview.passkeyDeviceCount',
      'identity.sessions.activeCount',
      'messages.conversationList.showMoreLabel',
      'article.metadata.wordCount',
      'article.metadata.readingMinuteCount',
      'layout.recommendations.viewCount'
    ] as const

    await activateLocaleRuntime('en-US', [
      'common',
      'layout',
      'public',
      'identity',
      'messages',
      'article'
    ])
    for (const key of keys) {
      expect(translatePlural(key, 0).includes('0')).toBe(true)
      expect(translatePlural(key, 1).includes('1')).toBe(true)
      expect(translatePlural(key, 2).includes('2')).toBe(true)
      expect(getPluralRulesForLocale('en-US').select(1)).toBe('one')
      expect(getPluralRulesForLocale('en-US').select(2)).toBe('other')
    }

    await requestLocale('ru-RU')
    const ruSamples = [0, 1, 2, 5, 11, 21, 22, 25] as const
    for (const key of keys) {
      for (const count of ruSamples) {
        const text = translatePlural(key, count)
        expect(text.includes(String(count))).toBe(true)
        // Category is selected from the raw number, not a preformatted display string.
        expect(getPluralRulesForLocale('ru-RU').select(count)).toMatch(/^(one|few|many|other)$/u)
      }
    }

    expect(getPluralRulesForLocale('ru-RU').select(21)).toBe('one')
    expect(getPluralRulesForLocale('ru-RU').select(22)).toBe('few')
    expect(getPluralRulesForLocale('ru-RU').select(25)).toBe('many')
    expect(translatePlural('identity.sessions.activeCount', 21)).toBe('21 активная сессия')
    expect(translatePlural('identity.sessions.activeCount', 22)).toBe('22 активные сессии')
    expect(translatePlural('identity.sessions.activeCount', 25)).toBe('25 активных сессий')
  })

  it('keeps number formatting separate from plural category selection', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'article'])
    // Category selection uses the raw numeric count (1 → one), even when a display
    // formatter would later render a different string representation.
    expect(getPluralRulesForLocale('en-US').select(1)).toBe('one')
    expect(translatePlural('article.metadata.wordCount', 1)).toBe('1 word')
    expect(translatePlural('article.metadata.wordCount', 2)).toBe('2 words')
  })

  it('fails closed on count parameter conflict without fallback', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    expect(() =>
      translatePlural('public.archive.publishedCount', 2, { count: 9 } as never)
    ).toThrowError('plural_count_conflict:en-US:public.archive.publishedCount')
  })
})
