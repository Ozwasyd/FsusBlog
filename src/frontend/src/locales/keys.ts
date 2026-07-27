import type { zhCN } from './zh-CN'

export { DEFAULT_LOCALE, ENABLED_LOCALES, getLocaleDescriptor, isSupportedLocale, parseSupportedLocale, type LocaleDescriptor, type SupportedLocale } from './localeCatalog'

export const LOCALE_PREFERENCE_STORAGE_KEY = 'fsusblog.locale'

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export type PluralMessage = Readonly<Record<PluralCategory, string>>

export type LocaleMessage = string | PluralMessage

export function isPluralMessage(value: unknown): value is PluralMessage {
    if (!value || typeof value !== 'object') return false
    const keys = Object.keys(value as Record<string, unknown>)
    return keys.length > 0 && keys.every(k =>
        ['zero', 'one', 'two', 'few', 'many', 'other'].includes(k))
}

export type DeepStringShape<T> = {
    readonly [Key in keyof T]: T[Key] extends PluralMessage
        ? PluralMessage
        : T[Key] extends string
          ? string
          : T[Key] extends Readonly<Record<string, unknown>>
            ? DeepStringShape<T[Key]>
            : never
}

export type LocaleMessages = DeepStringShape<typeof zhCN>

type OrdinaryStringLeafPaths<T> = {
    [Key in Extract<keyof T, string>]: T[Key] extends string
        ? Key
        : T[Key] extends Record<string, unknown>
      ? T[Key] extends PluralMessage
          ? never
          : `${Key}.${OrdinaryStringLeafPaths<T[Key]>}`
      : never
}[Extract<keyof T, string>]

type PluralMessageLeafPaths<T> = {
    [Key in Extract<keyof T, string>]: T[Key] extends PluralMessage
        ? Key
        : T[Key] extends Record<string, unknown>
          ? `${Key}.${PluralMessageLeafPaths<T[Key]>}`
          : never
}[Extract<keyof T, string>]

export type TranslationKey = OrdinaryStringLeafPaths<typeof zhCN>

export type PluralTranslationKey = PluralMessageLeafPaths<typeof zhCN>

export type TranslationParams = Readonly<Record<string, string | number>>
