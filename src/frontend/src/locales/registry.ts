export interface LocaleDescriptor {
    readonly code: string
    readonly bcp47: string
    readonly nativeName: string
    readonly englishName: string
    readonly direction: 'ltr' | 'rtl'
    readonly pluralRules: Intl.PluralRulesOptions['type']
    readonly script: string
    readonly bundlePath: string
}

export const DEFAULT_LOCALE = 'zh-CN' as const

export const LOCALE_REGISTRY: readonly LocaleDescriptor[] = [
    {
        code: 'zh-CN',
        bcp47: 'zh-CN',
        nativeName: '简体中文',
        englishName: 'Simplified Chinese',
        direction: 'ltr',
        pluralRules: 'cardinal',
        script: 'Hans',
        bundlePath: () => import('./zh-CN') as Promise<{ default: typeof import('./zh-CN').zhCN }>
    },
    {
        code: 'en-US',
        bcp47: 'en-US',
        nativeName: 'English',
        englishName: 'English',
        direction: 'ltr',
        pluralRules: 'ordinal',
        script: 'Latn',
        bundlePath: () => import('./en-US') as Promise<{ default: typeof import('./en-US').enUS }>
    },
    {
        code: 'zh-Hant',
        bcp47: 'zh-Hant',
        nativeName: '繁體中文',
        englishName: 'Traditional Chinese',
        direction: 'ltr',
        pluralRules: 'cardinal',
        script: 'Hant',
        bundlePath: null
    },
    {
        code: 'ja-JP',
        bcp47: 'ja-JP',
        nativeName: '日本語',
        englishName: 'Japanese',
        direction: 'ltr',
        pluralRules: 'cardinal',
        script: 'Jpan',
        bundlePath: null
    },
    {
        code: 'ko-KR',
        bcp47: 'ko-KR',
        nativeName: '한국어',
        englishName: 'Korean',
        direction: 'ltr',
        pluralRules: 'cardinal',
        script: 'Kore',
        bundlePath: null
    },
    {
        code: 'fr-FR',
        bcp47: 'fr-FR',
        nativeName: 'Français',
        englishName: 'French',
        direction: 'ltr',
        pluralRules: 'ordinal',
        script: 'Latn',
        bundlePath: null
    },
    {
        code: 'de-DE',
        bcp47: 'de-DE',
        nativeName: 'Deutsch',
        englishName: 'German',
        direction: 'ltr',
        pluralRules: 'cardinal',
        script: 'Latn',
        bundlePath: null
    },
    {
        code: 'es-419',
        bcp47: 'es-419',
        nativeName: 'Español (Latinoamérica)',
        englishName: 'Spanish (Latin America)',
        direction: 'ltr',
        pluralRules: 'cardinal',
        script: 'Latn',
        bundlePath: null
    },
    {
        code: 'pt-BR',
        bcp47: 'pt-BR',
        nativeName: 'Português (Brasil)',
        englishName: 'Portuguese (Brazil)',
        direction: 'ltr',
        pluralRules: 'ordinal',
        script: 'Latn',
        bundlePath: null
    },
    {
        code: 'ru-RU',
        bcp47: 'ru-RU',
        nativeName: 'Русский',
        englishName: 'Russian',
        direction: 'ltr',
        pluralRules: 'cardinal',
        script: 'Cyrl',
        bundlePath: null
    }
]

export const REGISTRY_BY_CODE: ReadonlyMap<string, LocaleDescriptor> =
    new Map(LOCALE_REGISTRY.map(d => [d.code, d]))

export const ACTIVE_LOCALES: ReadonlySet<string> =
    new Set(LOCALE_REGISTRY.filter(d => d.bundlePath !== null).map(d => d.code))

export const AVAILABLE_LOCALES: ReadonlySet<string> =
    new Set(LOCALE_REGISTRY.map(d => d.code))

export function isAvailableLocale(value: string): boolean {
    return AVAILABLE_LOCALES.has(value)
}

export function isActiveLocale(value: string): boolean {
    return ACTIVE_LOCALES.has(value)
}
