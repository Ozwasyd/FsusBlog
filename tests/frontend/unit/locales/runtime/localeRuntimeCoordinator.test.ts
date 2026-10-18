import { describe, expect, it, vi } from 'vitest'

import { prepareLocaleDomains } from '@/locales/runtime/localeRuntimeComposition'
import type { SupportedLocale } from '@/locales/keys'
import type { LocaleDomain } from '@/locales/localeDomains'
import {
  LocaleRuntimeCoordinator,
  type LocaleFontPreparationPort,
  type LocalePreferenceCommitPort,
  type LocaleRuntimePorts
} from '@/locales/runtime/localeRuntimeCoordinator'

const PUBLIC_DOMAINS = Object.freeze(['common', 'layout', 'public'] as const satisfies readonly LocaleDomain[])

function createPorts(options?: {
  domainDelayMs?: Partial<Record<SupportedLocale, number>>
  domainErrors?: Partial<Record<SupportedLocale, string>>
  fontErrors?: Partial<Record<SupportedLocale, string>>
  preferenceErrors?: string
  preferenceEffective?: SupportedLocale
}): {
  ports: LocaleRuntimePorts
  domainCalls: SupportedLocale[]
  fontCalls: SupportedLocale[]
  preferenceCalls: Array<'auto' | 'fixed'>
  metadataCalls: SupportedLocale[]
  commits: SupportedLocale[]
} {
  const domainCalls: SupportedLocale[] = []
  const fontCalls: SupportedLocale[] = []
  const preferenceCalls: Array<'auto' | 'fixed'> = []
  const metadataCalls: SupportedLocale[] = []
  const commits: SupportedLocale[] = []
  let revision = 0

  const domainBundlePort = {
    prepareLocaleDomains: vi.fn(async (locale: SupportedLocale, domains: readonly LocaleDomain[], signal?: AbortSignal) => {
      domainCalls.push(locale)
      const delay = options?.domainDelayMs?.[locale] ?? 0
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), delay)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new DOMException('Locale transaction aborted', 'AbortError'))
          }, { once: true })
        })
      }
      if (signal?.aborted) {
        throw new DOMException('Locale transaction aborted', 'AbortError')
      }
      if (options?.domainErrors?.[locale]) {
        throw new Error(options.domainErrors[locale])
      }
      return prepareLocaleDomains(locale, domains, signal)
    })
  }

  const fontPreparationPort: LocaleFontPreparationPort = {
    prepareLocaleFonts: vi.fn<LocaleFontPreparationPort['prepareLocaleFonts']>(async (locale, _weights, signal) => {
      fontCalls.push(locale)
      if (signal?.aborted) {
        throw new DOMException('Locale transaction aborted', 'AbortError')
      }
      if (options?.fontErrors?.[locale]) {
        throw new Error(options.fontErrors[locale])
      }
      return Object.freeze({ locale, generation: fontCalls.length })
    })
  }

  const preferenceCommitPort: LocalePreferenceCommitPort = {
    commit: vi.fn(async (command) => {
      preferenceCalls.push(command.mode)
      if (options?.preferenceErrors) {
        throw new Error(options.preferenceErrors)
      }
      revision += 1
      const effectiveLocale = command.mode === 'fixed'
        ? command.locale
        : (options?.preferenceEffective ?? 'zh-Hant')
      return Object.freeze({
        mode: command.mode,
        fixedLocale: command.mode === 'fixed' ? command.locale : null,
        effectiveLocale,
        revision
      })
    })
  }

  const ports: LocaleRuntimePorts = {
    domainBundlePort,
    fontPreparationPort,
    preferenceCommitPort,
    metadataPort: {
      commitDocumentMetadata: (locale) => {
        metadataCalls.push(locale)
      }
    },
    clock: { now: () => Date.now() },
    telemetryPort: {
      phase: () => undefined,
      failed: () => undefined,
      committed: (active) => {
        commits.push(active.locale)
      }
    }
  }

  return {
    ports,
    domainCalls,
    fontCalls,
    preferenceCalls,
    metadataCalls,
    commits
  }
}

describe('LocaleRuntimeCoordinator', () => {
  it('activates initial ja-JP only after domains and fonts are ready', async () => {
    const harness = createPorts()
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)

    const outcome = await coordinator.activateInitial('ja-JP', PUBLIC_DOMAINS)

    expect(outcome).toMatchObject({ status: 'active', locale: 'ja-JP' })
    expect(coordinator.snapshot().active?.locale).toBe('ja-JP')
    expect(harness.domainCalls).toEqual(['ja-JP'])
    expect(harness.fontCalls).toEqual(['ja-JP'])
    expect(harness.metadataCalls).toEqual(['ja-JP'])
    expect(harness.preferenceCalls).toEqual([])
    expect(harness.commits).toEqual(['ja-JP'])
  })

  it('fails closed when initial domains are missing and keeps no active authority', async () => {
    const harness = createPorts({
      domainErrors: { 'ko-KR': 'i18n_unprepared_domain:ko-KR:common' }
    })
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)

    const outcome = await coordinator.activateInitial('ko-KR', PUBLIC_DOMAINS)

    expect(outcome).toMatchObject({
      status: 'failed',
      target: 'ko-KR',
      reason: 'i18n_unprepared_domain:ko-KR:common'
    })
    expect(coordinator.snapshot().active).toBeNull()
    expect(coordinator.snapshot().failed?.reason).toContain('i18n_unprepared_domain:ko-KR:common')
    expect(harness.metadataCalls).toEqual([])
    expect(harness.commits).toEqual([])
  })

  it('keeps only the latest generation when de-DE is slow and ru-RU wins', async () => {
    const harness = createPorts({
      domainDelayMs: { 'de-DE': 40 }
    })
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)
    await coordinator.activateInitial('en-US', PUBLIC_DOMAINS)

    const slow = coordinator.requestLocale('de-DE', PUBLIC_DOMAINS)
    const fast = coordinator.requestLocale('ru-RU', PUBLIC_DOMAINS)
    const [slowOutcome, fastOutcome] = await Promise.all([slow, fast])

    expect(slowOutcome.status).toBe('superseded')
    expect(fastOutcome).toMatchObject({ status: 'active', locale: 'ru-RU' })
    expect(coordinator.snapshot().active?.locale).toBe('ru-RU')
    expect(harness.commits.at(-1)).toBe('ru-RU')
    expect(harness.metadataCalls.at(-1)).toBe('ru-RU')
  })

  it('keeps the old active UI when fonts fail after domains succeed', async () => {
    const harness = createPorts({
      fontErrors: { 'ja-JP': 'font_face_load_empty:ja-JP' }
    })
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)
    await coordinator.activateInitial('en-US', PUBLIC_DOMAINS)

    const outcome = await coordinator.requestLocale('ja-JP', PUBLIC_DOMAINS)

    expect(outcome).toMatchObject({
      status: 'failed',
      target: 'ja-JP',
      reason: 'font_face_load_empty:ja-JP'
    })
    expect(coordinator.snapshot().active?.locale).toBe('en-US')
    expect(harness.metadataCalls).toEqual(['en-US'])
    expect(harness.commits).toEqual(['en-US'])
  })

  it('keeps the old active UI when preference commit fails after resources succeed', async () => {
    const harness = createPorts({
      preferenceErrors: 'locale_preference_unavailable'
    })
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)
    await coordinator.activateInitial('en-US', PUBLIC_DOMAINS)

    const outcome = await coordinator.requestLocale('de-DE', PUBLIC_DOMAINS, {
      persistPreference: true
    })

    expect(outcome).toMatchObject({
      status: 'failed',
      target: 'de-DE',
      reason: 'locale_preference_unavailable'
    })
    expect(coordinator.snapshot().active?.locale).toBe('en-US')
    expect(harness.preferenceCalls).toEqual(['fixed'])
    expect(harness.metadataCalls).toEqual(['en-US'])
  })

  it('surfaces account revision conflict without publishing a mixed locale frame', async () => {
    const harness = createPorts({
      preferenceErrors: 'locale_preference_revision_conflict'
    })
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)
    await coordinator.activateInitial('en-US', PUBLIC_DOMAINS)

    const outcome = await coordinator.requestLocalePreference({
      mode: 'fixed',
      locale: 'fr-FR'
    }, PUBLIC_DOMAINS)

    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'locale_preference_revision_conflict'
    })
    expect(coordinator.snapshot().active?.locale).toBe('en-US')
    expect(harness.metadataCalls).toEqual(['en-US'])
  })

  it('reuses the in-flight producer for the same target and domains', async () => {
    const harness = createPorts({
      domainDelayMs: { 'ja-JP': 20 }
    })
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)
    await coordinator.activateInitial('en-US', PUBLIC_DOMAINS)

    const first = coordinator.requestLocale('ja-JP', PUBLIC_DOMAINS)
    const second = coordinator.requestLocale('ja-JP', PUBLIC_DOMAINS)
    const outcomes = await Promise.all([first, second])

    expect(outcomes.some((outcome) => outcome.status === 'active')).toBe(true)
    expect(coordinator.snapshot().active?.locale).toBe('ja-JP')
    expect(harness.domainCalls.filter((locale) => locale === 'ja-JP')).toHaveLength(1)
    expect(harness.fontCalls.filter((locale) => locale === 'ja-JP')).toHaveLength(1)
  })

  it('auto preference returns effective zh-Hant and commits that locale atomically', async () => {
    const harness = createPorts({
      preferenceEffective: 'zh-Hant'
    })
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)
    await coordinator.activateInitial('en-US', PUBLIC_DOMAINS)

    const outcome = await coordinator.requestLocalePreference({ mode: 'auto' }, PUBLIC_DOMAINS)

    expect(outcome).toMatchObject({ status: 'active', locale: 'zh-Hant' })
    expect(harness.preferenceCalls).toEqual(['auto'])
    expect(harness.domainCalls.at(-1)).toBe('zh-Hant')
    expect(harness.fontCalls.at(-1)).toBe('zh-Hant')
    expect(harness.metadataCalls.at(-1)).toBe('zh-Hant')
    expect(coordinator.snapshot().active?.locale).toBe('zh-Hant')
  })

  it('route domain expansion does not change locale identity or rebuild on failure', async () => {
    const harness = createPorts()
    const coordinator = new LocaleRuntimeCoordinator(harness.ports)
    await coordinator.activateInitial('en-US', PUBLIC_DOMAINS)
    const previousGeneration = coordinator.snapshot().active?.generation

    const transaction = await coordinator.beginRouteTransaction([
      ...PUBLIC_DOMAINS,
      'auth',
      'errors'
    ])
    expect(transaction.snapshot.locale).toBe('en-US')
    expect(transaction.snapshot.domains).toContain('auth')
    transaction.rollback()

    expect(coordinator.snapshot().active?.locale).toBe('en-US')
    expect(coordinator.snapshot().active?.generation).toBe(previousGeneration)
    expect(coordinator.snapshot().active?.loadedDomains).toEqual([...PUBLIC_DOMAINS])
  })
})
