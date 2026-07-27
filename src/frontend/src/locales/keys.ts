import type { admin } from './zh-CN/admin'
import type { article } from './zh-CN/article'
import type { auth } from './zh-CN/auth'
import type { common } from './zh-CN/common'
import type { errors } from './zh-CN/errors'
import type { identity } from './zh-CN/identity'
import type { layout } from './zh-CN/layout'
import type { messages } from './zh-CN/messages'
import type { publicMessages } from './zh-CN/public'
import type { security } from './zh-CN/security'

export { DEFAULT_LOCALE, ENABLED_LOCALES, getLocaleDescriptor, isSupportedLocale, parseSupportedLocale, type LocaleDescriptor, type SupportedLocale } from './localeCatalog'


export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const

export type PluralCategory = typeof PLURAL_CATEGORIES[number]

export interface PluralNode {
    readonly kind: 'plural'
    readonly forms: Readonly<{ other: string } & Partial<Record<Exclude<PluralCategory, 'other'>, string>>>
}

export type LocaleMessage = string | PluralNode

export type LocaleSchema<T> = {
    readonly [Key in keyof T]: T[Key] extends string
        ? string
        : T[Key] extends PluralNode
          ? PluralNode
          : T[Key] extends object
            ? LocaleSchema<T[Key]>
            : never
}

export type { LocaleMessages } from './localeDomains'

type ZhCnMessages = {
    common: typeof common
    public: typeof publicMessages
    article: typeof article
    auth: typeof auth
    identity: typeof identity
    layout: typeof layout
    messages: typeof messages
    security: typeof security
    admin: typeof admin
    errors: typeof errors
}

type OrdinaryStringLeafPaths<T> = {
    [Key in Extract<keyof T, string>]: T[Key] extends string
        ? Key
        : T[Key] extends PluralNode
          ? never
          : T[Key] extends object
            ? `${Key}.${OrdinaryStringLeafPaths<T[Key]>}`
            : never
}[Extract<keyof T, string>]

type PluralNodeLeafPaths<T> = {
    [Key in Extract<keyof T, string>]: T[Key] extends PluralNode
        ? Key
        : T[Key] extends object
          ? `${Key}.${PluralNodeLeafPaths<T[Key]>}`
          : never
}[Extract<keyof T, string>]

type ValueAtPath<T, Path extends string> =
    Path extends `${infer Head}.${infer Tail}`
        ? Head extends keyof T
            ? ValueAtPath<T[Head], Tail>
            : never
        : Path extends keyof T
          ? T[Path]
          : never

type InterpolationParameterNames<Message extends string> =
    Message extends `${string}{${infer Parameter}}${infer Tail}`
        ? Parameter | InterpolationParameterNames<Tail>
        : never

type ParametersForMessage<Message extends string> =
    [InterpolationParameterNames<Message>] extends [never]
        ? undefined
        : Readonly<Record<InterpolationParameterNames<Message>, string | number>>

type ParametersAtPath<Path extends string> =
    ValueAtPath<ZhCnMessages, Path> extends infer Message
        ? Message extends string
            ? ParametersForMessage<Message>
            : never
        : never

type PluralParametersAtPath<Path extends string> =
    ValueAtPath<ZhCnMessages, Path> extends { readonly kind: 'plural'; readonly forms: { readonly other: infer Other extends string } }
        ? ParametersForMessage<Other>
        : never

export type TranslationKey = OrdinaryStringLeafPaths<ZhCnMessages>

export type PluralTranslationKey = PluralNodeLeafPaths<ZhCnMessages>

export type TranslationParamsByKey = {
    readonly [Key in TranslationKey]: ParametersAtPath<Key>
}

export type PluralParamsByKey = {
    readonly [Key in PluralTranslationKey]: PluralParametersAtPath<Key>
}

export type TranslationArguments<Key extends TranslationKey> =
    TranslationParamsByKey[Key] extends undefined
        ? readonly [params?: undefined]
        : readonly [params: TranslationParamsByKey[Key]]

/**
 * Caller params for plural keys exclude auto-injected `count`.
 * `count` is a separate required numeric argument on translatePlural.
 */
type PluralCallerParams<Key extends PluralTranslationKey> =
    PluralParamsByKey[Key] extends undefined
        ? undefined
        : Omit<PluralParamsByKey[Key], 'count'> extends infer Rest
            ? [keyof Rest & string] extends [never]
                ? undefined
                : Readonly<Rest>
            : never

export type PluralTranslationArguments<Key extends PluralTranslationKey> =
    PluralCallerParams<Key> extends undefined
        ? readonly [count: number, params?: undefined]
        : readonly [count: number, params: PluralCallerParams<Key>]
