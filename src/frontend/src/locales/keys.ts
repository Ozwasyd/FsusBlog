import { DEFAULT_LOCALE, ACTIVE_LOCALES, isAvailableLocale, type LocaleDescriptor, REGISTRY_BY_CODE } from './registry'

export { DEFAULT_LOCALE, isAvailableLocale } from './registry'
export type { LocaleDescriptor } from './registry'

export const LOCALE_PREFERENCE_STORAGE_KEY = 'fsusblog.locale'

export type SupportedLocale = string & { readonly __brand?: unique symbol }

export function castSupported(value: string): SupportedLocale {
    if (!isAvailableLocale(value)) throw new Error(`locale_not_available:${value}`)
    return value as SupportedLocale
}

export function isActiveLocale(value: unknown): boolean {
    return typeof value === 'string' && ACTIVE_LOCALES.has(value)
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
    return typeof value === 'string' && isAvailableLocale(value)
}

export const ACTIVE_LOCAL_LIST: readonly SupportedLocale[] =
    [...ACTIVE_LOCALES].map(castSupported)

export function getLocaleDescriptor(code: string): LocaleDescriptor | undefined {
    return REGISTRY_BY_CODE.get(code)
}

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export type PluralMessage = Readonly<Record<PluralCategory, string>>

export type LocaleMessage = string | PluralMessage

export function isPluralMessage(value: unknown): value is PluralMessage {
    if (!value || typeof value !== 'object') return false
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length > 0 && keys.every(k =>
        ['zero', 'one', 'two', 'few', 'many', 'other'].includes(k))
}

export type DeepLocaleShape<T> = {
    readonly [Key in keyof T]: T[Key] extends string
        ? string | PluralMessage
        : T[Key] extends Readonly<Record<string, unknown>>
      ? DeepLocaleShape<T[Key]>
      : never
}

export type LocaleMessages = Record<string, unknown>

export type LeafPaths<T> = {
    [Key in Extract<keyof T, string>]: T[Key] extends string
        ? Key
        : T[Key] extends Record<string, unknown>
      ? T[Key] extends PluralMessage
          ? Key
          : `${Key}.${LeafPaths<T[Key]>}`
      : never
}[Extract<keyof T, string>]

export type TranslationKey = string

export type TranslationParams = Readonly<Record<string, string | number>>

export {
    LOCALE_REGISTRY,
    REGISTRY_BY_CODE,
    ACTIVE_LOCALES,
    AVAILABLE_LOCALES
} from './registry'
