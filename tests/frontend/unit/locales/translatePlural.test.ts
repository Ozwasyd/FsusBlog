// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateLocaleRuntime,
  beginLocaleRouteTransaction,
  createLocaleTextContext,
  getPluralRulesForLocale,
  messages,
  prepareLocaleDomains,
  resetLocaleRuntimeForTests,
  requestLocale,
  translate,
  translatePlural
} from '@/locales'
import * as localeDomainBundleStore from '@/locales/localeDomainBundleStore'

describe('translatePlural', () => {
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

  it('selects zh-CN / en-US / ru-RU categories for 0,1,2,5,11,21,22,25, negatives, and fractions', async () => {
    const samples = [0, 1, 2, 5, 11, 21, 22, 25, -1, -2.5, 1.5] as const

    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public'])
    for (const count of samples) {
      expect(getPluralRulesForLocale('zh-CN').select(count)).toBe('other')
      expect(translatePlural('public.archive.publishedCount', count))
        .toBe(`已发布 ${count} 篇`)
    }

    await requestLocale('en-US')
    for (const count of samples) {
      const category = getPluralRulesForLocale('en-US').select(count)
      const expected = category === 'one'
        ? `${count} post published`
        : `${count} posts published`
      expect(translatePlural('public.archive.publishedCount', count)).toBe(expected)
    }

    await requestLocale('ru-RU')
    const ruExpected: Record<string, (count: number) => string> = {
      one: (count) => `Опубликована ${count} статья`,
      few: (count) => `Опубликовано ${count} статьи`,
      many: (count) => `Опубликовано ${count} статей`,
      other: (count) => `Опубликовано ${count} статьи`
    }
    for (const count of samples) {
      const category = getPluralRulesForLocale('ru-RU').select(count)
      expect(translatePlural('public.archive.publishedCount', count))
        .toBe(ruExpected[category]!(count))
    }

    // ru-RU boundary: 22 → few (not many/one)
    expect(getPluralRulesForLocale('ru-RU').select(22)).toBe('few')
    expect(translatePlural('public.archive.publishedCount', 22))
      .toBe('Опубликовано 22 статьи')
  })

  it('rejects caller count override and non-finite counts without fallback', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])

    expect(() =>
      translatePlural(
        'public.archive.publishedCount',
        2,
        { count: 9 } as never
      )
    ).toThrowError('plural_count_conflict:en-US:public.archive.publishedCount')

    expect(() => translatePlural('public.archive.publishedCount', Number.NaN))
      .toThrowError('plural_count_invalid:en-US:public.archive.publishedCount:NaN')
    expect(() => translatePlural('public.archive.publishedCount', Number.POSITIVE_INFINITY))
      .toThrowError('plural_count_invalid:en-US:public.archive.publishedCount:Infinity')
  })

  it('fails closed when the target domain is not loaded and never triggers the bundle loader', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout'])
    const loadSpy = vi.spyOn(localeDomainBundleStore, 'loadLocaleDomains')
    const loadDomainSpy = vi.spyOn(localeDomainBundleStore, 'loadLocaleDomain')

    expect(() => translatePlural('public.archive.publishedCount', 2))
      .toThrowError('plural_key_domain_not_loaded:en-US:public:public.archive.publishedCount')
    expect(loadSpy).not.toHaveBeenCalled()
    expect(loadDomainSpy).not.toHaveBeenCalled()
  })

  it('fails closed on missing category without using other as a compatibility fallback', async () => {
    await activateLocaleRuntime('ru-RU', ['common', 'layout', 'public'])
    const publicDomain = messages.value.public as {
      archive: { publishedCount: { forms: Record<string, string> } }
    }
    const few = publicDomain.archive.publishedCount.forms.few
    delete publicDomain.archive.publishedCount.forms.few
    try {
      expect(getPluralRulesForLocale('ru-RU').select(22)).toBe('few')
      expect(() => translatePlural('public.archive.publishedCount', 22))
        .toThrowError('plural_category_missing:ru-RU:public.archive.publishedCount:few')
    } finally {
      publicDomain.archive.publishedCount.forms.few = few
    }
  })

  it('fails closed when the leaf is not a discriminated plural node', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    expect(() =>
      translatePlural('common.actions.save' as never, 1)
    ).toThrowError('plural_node_invalid:en-US:common.actions.save')
  })

  it('fails closed when a non-count interpolation parameter is missing', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    const publicDomain = messages.value.public as {
      archive: { publishedCount: { forms: Record<string, string> } }
    }
    const originalOne = publicDomain.archive.publishedCount.forms.one
    const originalOther = publicDomain.archive.publishedCount.forms.other
    publicDomain.archive.publishedCount.forms.one = '{count} post published about {title}'
    publicDomain.archive.publishedCount.forms.other = '{count} posts published about {title}'
    try {
      expect(() => translatePlural('public.archive.publishedCount', 1))
        .toThrowError('plural_parameter_missing:en-US:public.archive.publishedCount:title')
      expect(
        translatePlural(
          'public.archive.publishedCount',
          1,
          { title: 'archive' } as never
        )
      ).toBe('1 post published about archive')
    } finally {
      publicDomain.archive.publishedCount.forms.one = originalOne
      publicDomain.archive.publishedCount.forms.other = originalOther
    }
  })

  it('keeps ordinary translate free of plural-object guessing', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    expect(() =>
      translate('public.archive.publishedCount' as never)
    ).toThrowError('i18n_missing_message:en-US:public.archive.publishedCount')
  })

  it('reuses PluralRules instances per SupportedLocale', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    const first = getPluralRulesForLocale('en-US')
    const second = getPluralRulesForLocale('en-US')
    expect(second).toBe(first)

    await requestLocale('ru-RU')
    const ru = getPluralRulesForLocale('ru-RU')
    expect(ru).not.toBe(first)
    expect(getPluralRulesForLocale('ru-RU')).toBe(ru)
    expect(getPluralRulesForLocale('en-US')).toBe(first)
  })

  it('reads only the published readonly projection during a staged locale commit', async () => {
    await activateLocaleRuntime('en-US', ['common', 'layout', 'public'])
    const staged = await beginLocaleRouteTransaction([
      'common',
      'layout',
      'public',
      'auth'
    ])
    try {
      // Staged snapshot is not active; global plural resolve stays on published en-US.
      expect(translatePlural('public.archive.publishedCount', 1))
        .toBe('1 post published')
      const scoped = createLocaleTextContext(
        await prepareLocaleDomains('ru-RU', ['common', 'public'])
      )
      expect(scoped.translatePlural('public.archive.publishedCount', 22))
        .toBe('Опубликовано 22 статьи')
      // Global projection unchanged while scoped uses its own generation snapshot.
      expect(translatePlural('public.archive.publishedCount', 22))
        .toBe('22 posts published')
    } finally {
      staged.rollback()
    }
  })
})
