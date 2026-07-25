import { computed, readonly, shallowRef } from 'vue'
import { DEFAULT_LOCALE, LOCALE_PREFERENCE_STORAGE_KEY, isSupportedLocale, ACTIVE_LOCALES } from './keys'
import type { LocaleMessages, SupportedLocale } from './keys'
import { loadBundle, getCachedBundle } from './bundleLoader'
import { syncLocaleDocumentMetadata } from './documentMetadata'

import { zhCN } from './zh-CN'
import { enUS } from './en-US'
import { frFR } from './fr-FR'
import { ptBR } from './pt-BR'

export { isSupportedLocale } from './keys'
export { DEFAULT_LOCALE, LOCALE_PREFERENCE_STORAGE_KEY } from './keys'
export const ENABLED_LOCALES: ReadonlySet<string> = ACTIVE_LOCALES

const BOOTSTRAP_BUNDLES: Record<string, LocaleMessages> = {
    'zh-CN': zhCN,
    'en-US': enUS,
    'fr-FR': frFR,
    'pt-BR': ptBR
}

const localeMessages = new Map<string, LocaleMessages>()
localeMessages.set('zh-CN', zhCN)
localeMessages.set('en-US', enUS)
localeMessages.set('fr-FR', frFR)
localeMessages.set('pt-BR', ptBR)

const localeState = shallowRef<SupportedLocale>(DEFAULT_LOCALE)
let runtimeInitialized = false
let storageListener: ((event: StorageEvent) => void) | null = null

export { localeState as locale }
export const messages = computed<LocaleMessages>(() =>
    localeMessages.get(localeState.value) ?? localeMessages.get(DEFAULT_LOCALE)!
)

export function getLocaleMessages(value: SupportedLocale): LocaleMessages {
    return localeMessages.get(value) ?? localeMessages.get(DEFAULT_LOCALE)!
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

export function translate(key: string, params?: Record<string, string | number>): string {
    return translateUnsafe(key, params)
}

export function translateUnsafe(key: string, params?: Record<string, string | number>): string {
    const requestedLocale = localeState.value
    const localized = resolveMessage(messages.value, key)
    if (localized !== null) return interpolate(localized, params)
    throw new Error(`i18n_missing_message:${requestedLocale}:${key}`)
}

let activeSwitch: Promise<SupportedLocale> | null = null

export async function setLocale(value: SupportedLocale): Promise<SupportedLocale> {
    if (activeSwitch) {
        try { await activeSwitch } catch { /* superseded */ }
    }
    activeSwitch = performSwitch(value)
    try {
        return await activeSwitch
    } finally {
        activeSwitch = null
    }
}

async function performSwitch(value: SupportedLocale): Promise<SupportedLocale> {
    const prev = localeState.value
    if (value === prev) return value

    if (!localeMessages.has(value)) {
        const bundle = await loadBundle(value)
        localeMessages.set(value, bundle)
    }

    localeState.value = value
    syncLocaleDocumentMetadata(value)
    if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, value)
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('fsus:locale-change', {
            detail: { locale: value, previousLocale: prev }
        }))
    }
    return value
}

export function toggleLocale(): SupportedLocale {
    const next = localeState.value === 'zh-CN' ? 'en-US' : 'zh-CN'
    localeState.value = next
    syncLocaleDocumentMetadata(next)
    if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, next)
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('fsus:locale-change', {
            detail: { locale: next, previousLocale: localeState.value }
        }))
    }
    return next
}

export function initializeLocaleRuntime(initialLocale?: SupportedLocale): SupportedLocale {
    if (runtimeInitialized) {
        if (initialLocale && initialLocale !== localeState.value) {
            applyLocale(initialLocale, false)
        }
        syncLocaleDocumentMetadata()
        return localeState.value
    }

    runtimeInitialized = true
    const storedLocale = typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(LOCALE_PREFERENCE_STORAGE_KEY)
    const resolvedLocale = initialLocale ?? (isSupportedLocale(storedLocale) ? storedLocale : DEFAULT_LOCALE)

    if (typeof window !== 'undefined') {
        storageListener = (event: StorageEvent) => {
            if (event.key === LOCALE_PREFERENCE_STORAGE_KEY && isSupportedLocale(event.newValue)) {
                applyLocale(event.newValue, false)
            }
        }
        window.addEventListener('storage', storageListener)
    }

    return applyLocale(resolvedLocale, false)
}

function applyLocale(value: SupportedLocale, persist: boolean): SupportedLocale {
    localeState.value = value
    if (persist && typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, value)
    syncLocaleDocumentMetadata(value)
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('fsus:locale-change', { detail: { locale: value } }))
    }
    return value
}

export function formatDate(
    value: string | number | Date,
    options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
): string {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return translate('common.time.invalid')
    return new Intl.DateTimeFormat(localeState.value, options).format(date)
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(localeState.value, options).format(value)
}

export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string {
    return new Intl.RelativeTimeFormat(localeState.value, { numeric: 'auto' }).format(value, unit)
}

export function resetLocaleRuntimeForTests(): void {
    if (storageListener && typeof window !== 'undefined') {
        window.removeEventListener('storage', storageListener)
    }
    storageListener = null
    runtimeInitialized = false
    localeState.value = DEFAULT_LOCALE
}
