export const DEFAULT_LOCALE = 'zh-CN' as const
export const ENABLED_LOCALES = ['zh-CN', 'en-US'] as const
export const LOCALE_PREFERENCE_STORAGE_KEY = 'fsusblog.locale'

export type SupportedLocale = (typeof ENABLED_LOCALES)[number]

export type DeepStringShape<T> = {
  readonly [Key in keyof T]: T[Key] extends string
    ? string
    : T[Key] extends Readonly<Record<string, unknown>>
      ? DeepStringShape<T[Key]>
      : never
}

export type LeafPaths<T> = {
  [Key in Extract<keyof T, string>]: T[Key] extends string
    ? Key
    : T[Key] extends Readonly<Record<string, unknown>>
      ? `${Key}.${LeafPaths<T[Key]>}`
      : never
}[Extract<keyof T, string>]

export type TranslationParams = Readonly<Record<string, string | number>>

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (ENABLED_LOCALES as readonly string[]).includes(value)
}
