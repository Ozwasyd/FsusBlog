import {
    computed,
    shallowRef,
    type App,
    type ComputedRef,
    type InjectionKey
} from 'vue'
import { getLocaleDescriptor } from './keys'
import type {
    LocaleMessages,
    SupportedLocale,
    TranslationArguments,
    TranslationKey
} from './keys'
import {
    activateLocaleRuntime,
    activeLocale,
    beginLocaleRouteTransaction,
    getLocaleProjection,
    messages,
    prepareLocaleDomains,
    PUBLIC_SHELL_LOCALE_DOMAINS,
    requestLocale,
    requestLocalePreference,
    resetLocaleRuntimeForTests,
    type PreparedLocaleDomains
} from './runtime/localeRuntimeComposition'

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

export {
    activateLocaleRuntime,
    activeLocale,
    beginLocaleRouteTransaction,
    messages,
    prepareLocaleDomains,
    PUBLIC_SHELL_LOCALE_DOMAINS,
    requestLocale,
    requestLocalePreference,
    resetLocaleRuntimeForTests
}

export type { PreparedLocaleDomains }

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
    snapshot: Pick<{ locale: SupportedLocale; messages: LocaleMessages }, 'locale' | 'messages'>,
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
    return translateFrom(getLocaleProjection(), key, ...args)
}

function formatDateForLocale(
    snapshot: Pick<{ locale: SupportedLocale; messages: LocaleMessages }, 'locale' | 'messages'>,
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

export function createLocaleTextContext(snapshot: PreparedLocaleDomains): LocaleTextContext {
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
    return formatDateForLocale(getLocaleProjection(), value, options)
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(
        getLocaleDescriptor(getLocaleProjection().locale).intlLocale,
        options
    ).format(value)
}

export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string {
    return new Intl.RelativeTimeFormat(
        getLocaleDescriptor(getLocaleProjection().locale).intlLocale,
        { numeric: 'auto' }
    ).format(value, unit)
}
