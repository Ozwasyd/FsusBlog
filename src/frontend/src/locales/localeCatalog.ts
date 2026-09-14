// Generated from src/shared/Contracts/Localization/locale-catalog.json; digest fce3a21533d93d0d8bcfd0d9eb50acd554f2d639286d97443f0685da03620db0; do not edit by hand.

export const LOCALE_CATALOG_DIGEST = 'fce3a21533d93d0d8bcfd0d9eb50acd554f2d639286d97443f0685da03620db0' as const;
export const DEFAULT_LOCALE = "zh-CN" as const;
export const LOCALE_CATALOG = [
    {
        "code": "zh-CN",
        "bcp47": "zh-CN",
        "documentLanguage": "zh-CN",
        "intlLocale": "zh-CN",
        "openGraphLocale": "zh_CN",
        "nativeName": "简体中文",
        "englishName": "Simplified Chinese",
        "direction": "ltr",
        "script": "Hans",
        "status": "enabled",
        "aliases": [
            "zh"
        ]
    },
    {
        "code": "en-US",
        "bcp47": "en-US",
        "documentLanguage": "en-US",
        "intlLocale": "en-US",
        "openGraphLocale": "en_US",
        "nativeName": "English",
        "englishName": "English",
        "direction": "ltr",
        "script": "Latn",
        "status": "enabled",
        "aliases": [
            "en"
        ]
    },
    {
        "code": "zh-Hant",
        "bcp47": "zh-Hant",
        "documentLanguage": "zh-Hant",
        "intlLocale": "zh-Hant",
        "openGraphLocale": "zh_TW",
        "nativeName": "繁體中文",
        "englishName": "Traditional Chinese",
        "direction": "ltr",
        "script": "Hant",
        "status": "enabled",
        "aliases": [
            "zh-tw",
            "zh-hk",
            "zh-mo"
        ]
    },
    {
        "code": "ja-JP",
        "bcp47": "ja-JP",
        "documentLanguage": "ja-JP",
        "intlLocale": "ja-JP",
        "openGraphLocale": "ja_JP",
        "nativeName": "日本語",
        "englishName": "Japanese",
        "direction": "ltr",
        "script": "Jpan",
        "status": "enabled",
        "aliases": [
            "ja"
        ]
    },
    {
        "code": "ko-KR",
        "bcp47": "ko-KR",
        "documentLanguage": "ko-KR",
        "intlLocale": "ko-KR",
        "openGraphLocale": "ko_KR",
        "nativeName": "한국어",
        "englishName": "Korean",
        "direction": "ltr",
        "script": "Kore",
        "status": "enabled",
        "aliases": [
            "ko"
        ]
    },
    {
        "code": "es-419",
        "bcp47": "es-419",
        "documentLanguage": "es-419",
        "intlLocale": "es-419",
        "openGraphLocale": "es_419",
        "nativeName": "Español (Latinoamérica)",
        "englishName": "Spanish (Latin America)",
        "direction": "ltr",
        "script": "Latn",
        "status": "enabled",
        "aliases": [
            "es"
        ]
    },
    {
        "code": "fr-FR",
        "bcp47": "fr-FR",
        "documentLanguage": "fr-FR",
        "intlLocale": "fr-FR",
        "openGraphLocale": "fr_FR",
        "nativeName": "Français",
        "englishName": "French",
        "direction": "ltr",
        "script": "Latn",
        "status": "enabled",
        "aliases": [
            "fr"
        ]
    },
    {
        "code": "de-DE",
        "bcp47": "de-DE",
        "documentLanguage": "de-DE",
        "intlLocale": "de-DE",
        "openGraphLocale": "de_DE",
        "nativeName": "Deutsch",
        "englishName": "German",
        "direction": "ltr",
        "script": "Latn",
        "status": "enabled",
        "aliases": [
            "de"
        ]
    },
    {
        "code": "pt-BR",
        "bcp47": "pt-BR",
        "documentLanguage": "pt-BR",
        "intlLocale": "pt-BR",
        "openGraphLocale": "pt_BR",
        "nativeName": "Português (Brasil)",
        "englishName": "Portuguese (Brazil)",
        "direction": "ltr",
        "script": "Latn",
        "status": "enabled",
        "aliases": [
            "pt"
        ]
    },
    {
        "code": "ru-RU",
        "bcp47": "ru-RU",
        "documentLanguage": "ru-RU",
        "intlLocale": "ru-RU",
        "openGraphLocale": "ru_RU",
        "nativeName": "Русский",
        "englishName": "Russian",
        "direction": "ltr",
        "script": "Cyrl",
        "status": "enabled",
        "aliases": [
            "ru"
        ]
    }
] as const;
export const ENABLED_LOCALES = LOCALE_CATALOG.filter((locale) => locale.status === 'enabled');
export type SupportedLocale = typeof ENABLED_LOCALES[number]['code'];
export type LocaleDescriptor = typeof ENABLED_LOCALES[number];
const descriptorByCode: ReadonlyMap<string, LocaleDescriptor> = new Map(ENABLED_LOCALES.map((locale) => [locale.code, locale]));
const codeByAlias: ReadonlyMap<string, SupportedLocale> = new Map(ENABLED_LOCALES.flatMap((locale) => [locale.code, ...locale.aliases].map((alias) => [alias.toLowerCase(), locale.code] as const)));
export function parseSupportedLocale(value: unknown): SupportedLocale | undefined
{
    return typeof value === 'string' ? codeByAlias.get(value.toLowerCase()) : undefined;
}
export function isSupportedLocale(value: unknown): value is SupportedLocale
{
    return typeof value === 'string' && descriptorByCode.has(value);
}
export function getLocaleDescriptor(value: SupportedLocale): LocaleDescriptor
{
    return descriptorByCode.get(value)!;
}
