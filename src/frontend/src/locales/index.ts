import {
    computed,
    shallowRef,
    type App,
    type ComputedRef,
    type InjectionKey,
    type ShallowRef
} from 'vue'
import {
    DEFAULT_LOCALE,
    getLocaleDescriptor,
    isSupportedLocale
} from './keys'
import type {
    LocaleMessages,
    SupportedLocale,
    TranslationArguments,
    TranslationKey
} from './keys'
import {
    loadLocaleDomains,
    peekLocaleDomain
} from './localeDomainBundleStore'
import type {
    LocaleDomain,
    LocaleDomainArtifact
} from './localeDomains'
import { syncLocaleDocumentMetadata } from './documentMetadata'

export { isSupportedLocale, parseSupportedLocale } from './keys'
export { DEFAULT_LOCALE } from './keys'
export { ENABLED_LOCALES } from './localeCatalog'
export { LOCALE_DOMAINS, isLocaleDomain, type LocaleDomain } from './localeDomains'
export {
    loadLocaleDomain,
    loadLocaleDomains,
    peekLocaleDomain,
    LocaleDomainBundleStore
} from './localeDomainBundleStore'

export const PUBLIC_SHELL_LOCALE_DOMAINS = Object.freeze([
    'common',
    'layout',
    'public'
] as const satisfies readonly LocaleDomain[])

const EMPTY_MESSAGES = Object.freeze({}) as LocaleMessages

export type PreparedLocaleDomains = Readonly<{
    locale: SupportedLocale
    domains: readonly LocaleDomain[]
    messages: LocaleMessages
    identities: readonly Readonly<{
        locale: SupportedLocale
        domain: LocaleDomain
    }>[]
}>

type LocaleProjection = Readonly<{
    initialized: boolean
    locale: SupportedLocale
    domains: readonly LocaleDomain[]
    messages: LocaleMessages
    revision: number
}>

export type PreparedLocaleRouteTransaction = Readonly<{
    snapshot: PreparedLocaleDomains
    commit: () => void
    rollback: () => void
}>

export type LocaleTextContext = Readonly<{
    activeLocale: ComputedRef<SupportedLocale>
    messages: ComputedRef<LocaleMessages>
    translate: <Key extends TranslationKey>(
        key: Key,
        ...args: TranslationArguments<Key>
    ) => string
    formatDate: (
        value: string | number | Date,
        options?: Intl.DateTimeFormatOptions
    ) => string
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
    formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) => string
}>

export const LOCALE_TEXT_CONTEXT_KEY: InjectionKey<LocaleTextContext> =
    Symbol('fsusblog.locale-text-context')

const projectionState: ShallowRef<LocaleProjection> = shallowRef(Object.freeze({
    initialized: false,
    locale: DEFAULT_LOCALE,
    domains: PUBLIC_SHELL_LOCALE_DOMAINS,
    messages: EMPTY_MESSAGES,
    revision: 0
}))
const localeState = computed(() => projectionState.value.locale)
const messagesState = computed(() => projectionState.value.messages)
let transactionTail: Promise<void> = Promise.resolve()

export { localeState as activeLocale }
export { messagesState as messages }

function abortError(): DOMException {
    return new DOMException('Locale transaction aborted', 'AbortError')
}

function normalizeDomains(domains: readonly LocaleDomain[]): readonly LocaleDomain[] {
    return Object.freeze([...new Set(domains)])
}

function assertPreparedSnapshot(snapshot: PreparedLocaleDomains): void {
    if (snapshot.domains.length !== snapshot.identities.length) {
        throw new Error(`i18n_snapshot_identity_count_drift:${snapshot.locale}`)
    }
    for (let index = 0; index < snapshot.domains.length; index += 1) {
        const domain = snapshot.domains[index]
        const identity = snapshot.identities[index]
        if (
            !domain
            || identity?.locale !== snapshot.locale
            || identity.domain !== domain
            || !(domain in snapshot.messages)
        ) {
            throw new Error(`i18n_snapshot_identity_drift:${snapshot.locale}:${String(domain)}`)
        }
    }
}

/**
 * Pure preparation boundary. Loading and validation may populate the bundle
 * store's artifact cache, but no active locale, message projection, metadata,
 * preference, or event is changed here.
 */
export async function prepareLocaleDomains(
    value: SupportedLocale,
    domains: readonly LocaleDomain[],
    signal?: AbortSignal
): Promise<PreparedLocaleDomains> {
    if (!isSupportedLocale(value)) throw new Error(`unsupported_locale:${String(value)}`)
    if (signal?.aborted) throw abortError()

    const normalizedDomains = normalizeDomains(domains)
    const artifacts = await loadLocaleDomains(value, normalizedDomains, signal)
    const entries = normalizedDomains.map((domain) => {
        const artifact = artifacts[domain]
        if (!artifact) throw new Error(`i18n_unprepared_domain:${value}:${domain}`)
        return [domain, artifact] as const
    })
    const snapshot = Object.freeze({
        locale: value,
        domains: normalizedDomains,
        messages: Object.freeze(Object.fromEntries(entries)) as LocaleMessages,
        identities: Object.freeze(normalizedDomains.map((domain) =>
            Object.freeze({ locale: value, domain })))
    })
    assertPreparedSnapshot(snapshot)
    return snapshot
}

function resolveMessage(dictionary: LocaleMessages, key: string): string | null {
    let current: unknown = dictionary
    for (const segment of key.split('.')) {
        if (!current || typeof current !== 'object' || !(segment in current)) return null
        current = (current as Record<string, unknown>)[segment]
    }
    return typeof current === 'string' ? current : null
}

function interpolate(message: string, params: Record<string, string | number> = {}): string {
    return message.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (token, key: string) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : token)
}

function translateFrom<Key extends TranslationKey>(
    snapshot: Pick<LocaleProjection, 'locale' | 'messages'>,
    key: Key,
    ...args: TranslationArguments<Key>
): string {
    const localized = resolveMessage(snapshot.messages, key)
    if (localized !== null) return interpolate(localized, args[0])
    throw new Error(`i18n_missing_message:${snapshot.locale}:${key}`)
}

export function translate<Key extends TranslationKey>(
    key: Key,
    ...args: TranslationArguments<Key>
): string {
    return translateFrom(projectionState.value, key, ...args)
}

function formatDateForLocale(
    snapshot: Pick<LocaleProjection, 'locale' | 'messages'>,
    value: string | number | Date,
    options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
): string {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
        return translateFrom(snapshot, 'common.time.invalid')
    }
    return new Intl.DateTimeFormat(
        getLocaleDescriptor(snapshot.locale).intlLocale,
        options
    ).format(date)
}

function commitProjection(
    snapshot: PreparedLocaleDomains,
    options: Readonly<{
        emit: boolean
    }>
): SupportedLocale {
    assertPreparedSnapshot(snapshot)

    // DOM metadata has no asynchronous observer point here. Publish the one
    // projection ref only after metadata is complete so Vue watchers can never
    // observe a new locale with old messages or document identity.
    syncLocaleDocumentMetadata(snapshot.locale)
    projectionState.value = Object.freeze({
        initialized: true,
        locale: snapshot.locale,
        domains: snapshot.domains,
        messages: snapshot.messages,
        revision: projectionState.value.revision + 1
    })

    if (options.emit && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('fsus:locale-change', {
            detail: { locale: snapshot.locale }
        }))
    }
    return snapshot.locale
}

function commitRouteProjection(snapshot: PreparedLocaleDomains): void {
    assertPreparedSnapshot(snapshot)
    if (projectionState.value.locale !== snapshot.locale) {
        throw new Error(
            `i18n_route_snapshot_locale_stale:${snapshot.locale}:${projectionState.value.locale}`
        )
    }
    projectionState.value = Object.freeze({
        ...projectionState.value,
        domains: snapshot.domains,
        messages: snapshot.messages,
        revision: projectionState.value.revision + 1
    })
}

async function acquireLocaleTransaction(signal?: AbortSignal): Promise<() => void> {
    let releaseCurrent!: () => void
    const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve
    })
    const previous = transactionTail
    transactionTail = previous.then(() => current)
    await previous
    if (signal?.aborted) {
        releaseCurrent()
        throw abortError()
    }
    let released = false
    return () => {
        if (released) return
        released = true
        releaseCurrent()
    }
}

/**
 * Stages an immutable route projection while holding the locale transaction
 * lease. Router owns the final commit/rollback after navigation succeeds or
 * fails, so redirects and guard failures cannot publish candidate domains.
 */
export async function beginLocaleRouteTransaction(
    domains: readonly LocaleDomain[],
    signal?: AbortSignal
): Promise<PreparedLocaleRouteTransaction> {
    const release = await acquireLocaleTransaction(signal)
    try {
        const snapshot = await prepareLocaleDomains(
            projectionState.value.locale,
            domains,
            signal
        )
        let settled = false
        const settle = (commit: boolean): void => {
            if (settled) return
            settled = true
            try {
                if (commit) commitRouteProjection(snapshot)
            } finally {
                release()
            }
        }
        return Object.freeze({
            snapshot,
            commit: () => settle(true),
            rollback: () => settle(false)
        })
    } catch (error) {
        release()
        throw error
    }
}

/**
 * Requests one explicit catalog locale. The immutable domain set is captured
 * only after the transaction lease is acquired, so a concurrent successful
 * route commit is included and a failed domain load leaves the old projection
 * and metadata untouched.
 */
export async function requestLocale(value: SupportedLocale): Promise<SupportedLocale> {
    if (!isSupportedLocale(value)) throw new Error(`unsupported_locale:${String(value)}`)
    const release = await acquireLocaleTransaction()
    try {
        const current = projectionState.value
        if (current.initialized && value === current.locale) return value
        const snapshot = await prepareLocaleDomains(value, current.domains)
        return commitProjection(snapshot, { emit: true })
    } finally {
        release()
    }
}

function resolveInitialLocale(initialLocale?: SupportedLocale): SupportedLocale {
    if (initialLocale) return initialLocale
    const documentLocale = typeof document === 'undefined'
        ? null
        : document.documentElement.lang
    return isSupportedLocale(documentLocale) ? documentLocale : DEFAULT_LOCALE
}

export async function initializeLocaleRuntime(
    initialLocale?: SupportedLocale,
    domains: readonly LocaleDomain[] = PUBLIC_SHELL_LOCALE_DOMAINS
): Promise<SupportedLocale> {
    const release = await acquireLocaleTransaction()
    try {
        const resolvedLocale = resolveInitialLocale(initialLocale)
        const snapshot = await prepareLocaleDomains(resolvedLocale, domains)
        const locale = commitProjection(snapshot, { emit: false })
        return locale
    } finally {
        release()
    }
}

export function createLocaleTextContext(snapshot: PreparedLocaleDomains): LocaleTextContext {
    assertPreparedSnapshot(snapshot)
    const scopedProjection = shallowRef(Object.freeze({
        initialized: true,
        locale: snapshot.locale,
        domains: snapshot.domains,
        messages: snapshot.messages,
        revision: 1
    }))
    const scopedLocale = computed(() => scopedProjection.value.locale)
    const scopedMessages = computed(() => scopedProjection.value.messages)
    return Object.freeze({
        activeLocale: scopedLocale,
        messages: scopedMessages,
        translate: <Key extends TranslationKey>(
            key: Key,
            ...args: TranslationArguments<Key>
        ) => translateFrom(scopedProjection.value, key, ...args),
        formatDate: (
            value: string | number | Date,
            options?: Intl.DateTimeFormatOptions
        ) => formatDateForLocale(scopedProjection.value, value, options),
        formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
            new Intl.NumberFormat(
                getLocaleDescriptor(scopedProjection.value.locale).intlLocale,
                options
            ).format(value),
        formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) =>
            new Intl.RelativeTimeFormat(
                getLocaleDescriptor(scopedProjection.value.locale).intlLocale,
                { numeric: 'auto' }
            ).format(value, unit)
    })
}

export function provideLocaleTextContext(
    app: Pick<App, 'provide'>,
    snapshot: PreparedLocaleDomains
): void {
    app.provide(LOCALE_TEXT_CONTEXT_KEY, createLocaleTextContext(snapshot))
}

export function formatDate(
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions
): string {
    return formatDateForLocale(projectionState.value, value, options)
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(
        getLocaleDescriptor(projectionState.value.locale).intlLocale,
        options
    ).format(value)
}

export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string {
    return new Intl.RelativeTimeFormat(
        getLocaleDescriptor(projectionState.value.locale).intlLocale,
        { numeric: 'auto' }
    ).format(value, unit)
}

export function resetLocaleRuntimeForTests(): void {
    projectionState.value = Object.freeze({
        initialized: false,
        locale: DEFAULT_LOCALE,
        domains: PUBLIC_SHELL_LOCALE_DOMAINS,
        messages: EMPTY_MESSAGES,
        revision: projectionState.value.revision + 1
    })
}
