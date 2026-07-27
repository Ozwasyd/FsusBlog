// Generated from src/shared/Contracts/Localization/locale-catalog.json; digest fce3a21533d93d0d8bcfd0d9eb50acd554f2d639286d97443f0685da03620db0; do not edit by hand.
// Font projection digest 9a4b867f76ca31604b87b656e6d9d9399206b9705bb606226446e09646a62070; generated with the locale catalog.

import type { SupportedLocale } from './localeCatalog';

export const LOCALE_FONT_CATALOG_SCHEMA = 'fsusblog.locale-font-catalog.v1' as const;
export const LOCALE_FONT_CATALOG_DIGEST = '9a4b867f76ca31604b87b656e6d9d9399206b9705bb606226446e09646a62070' as const;
export const LOCALE_FONT_WEIGHTS = Object.freeze([
    400,
    500,
    700
] as const);
export type LocaleFontWeight = typeof LOCALE_FONT_WEIGHTS[number];
export const SCRIPT_FONT_CATALOG = Object.freeze({
    "Hans": {
        "family": "Noto Sans SC",
        "facePrefix": "noto-sans-sc",
        "assetEntry": "font-script-hans",
        "assetFile": "hans.css",
        "representativeText": "汉语字形"
    },
    "Hant": {
        "family": "Noto Sans TC",
        "facePrefix": "noto-sans-tc",
        "assetEntry": "font-script-hant",
        "assetFile": "hant.css",
        "representativeText": "漢語字形"
    },
    "Jpan": {
        "family": "Noto Sans JP",
        "facePrefix": "noto-sans-jp",
        "assetEntry": "font-script-jpan",
        "assetFile": "jpan.css",
        "representativeText": "日本語字形"
    },
    "Kore": {
        "family": "Noto Sans KR",
        "facePrefix": "noto-sans-kr",
        "assetEntry": "font-script-kore",
        "assetFile": "kore.css",
        "representativeText": "한국어글꼴"
    },
    "Latn": {
        "family": "Google Sans",
        "facePrefix": "google-sans-latin-ext",
        "assetEntry": "font-script-latn",
        "assetFile": "latn.css",
        "representativeText": "Àéñçõ"
    },
    "Cyrl": {
        "family": "Google Sans",
        "facePrefix": "google-sans-cyrillic",
        "assetEntry": "font-script-cyrl",
        "assetFile": "cyrl.css",
        "representativeText": "Привет"
    }
} as const);
export type LocaleFontScript = keyof typeof SCRIPT_FONT_CATALOG;
export type LocaleFontDescriptor = Readonly<{
    locale: SupportedLocale;
    script: LocaleFontScript;
    family: string;
    faceIds: readonly string[];
    weights: readonly LocaleFontWeight[];
    assetEntry: string;
    assetFile: string;
    representativeText: string;
}>;
export const LOCALE_FONT_CATALOG = Object.freeze({
    "zh-CN": {
        "locale": "zh-CN",
        "script": "Hans",
        "family": "Noto Sans SC",
        "faceIds": [
            "noto-sans-sc:400",
            "noto-sans-sc:500",
            "noto-sans-sc:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-hans",
        "assetFile": "hans.css",
        "representativeText": "汉语字形"
    },
    "en-US": {
        "locale": "en-US",
        "script": "Latn",
        "family": "Google Sans",
        "faceIds": [
            "google-sans-latin-ext:400",
            "google-sans-latin-ext:500",
            "google-sans-latin-ext:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-latn",
        "assetFile": "latn.css",
        "representativeText": "Àéñçõ"
    },
    "zh-Hant": {
        "locale": "zh-Hant",
        "script": "Hant",
        "family": "Noto Sans TC",
        "faceIds": [
            "noto-sans-tc:400",
            "noto-sans-tc:500",
            "noto-sans-tc:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-hant",
        "assetFile": "hant.css",
        "representativeText": "漢語字形"
    },
    "ja-JP": {
        "locale": "ja-JP",
        "script": "Jpan",
        "family": "Noto Sans JP",
        "faceIds": [
            "noto-sans-jp:400",
            "noto-sans-jp:500",
            "noto-sans-jp:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-jpan",
        "assetFile": "jpan.css",
        "representativeText": "日本語字形"
    },
    "ko-KR": {
        "locale": "ko-KR",
        "script": "Kore",
        "family": "Noto Sans KR",
        "faceIds": [
            "noto-sans-kr:400",
            "noto-sans-kr:500",
            "noto-sans-kr:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-kore",
        "assetFile": "kore.css",
        "representativeText": "한국어글꼴"
    },
    "es-419": {
        "locale": "es-419",
        "script": "Latn",
        "family": "Google Sans",
        "faceIds": [
            "google-sans-latin-ext:400",
            "google-sans-latin-ext:500",
            "google-sans-latin-ext:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-latn",
        "assetFile": "latn.css",
        "representativeText": "Àéñçõ"
    },
    "fr-FR": {
        "locale": "fr-FR",
        "script": "Latn",
        "family": "Google Sans",
        "faceIds": [
            "google-sans-latin-ext:400",
            "google-sans-latin-ext:500",
            "google-sans-latin-ext:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-latn",
        "assetFile": "latn.css",
        "representativeText": "Àéñçõ"
    },
    "de-DE": {
        "locale": "de-DE",
        "script": "Latn",
        "family": "Google Sans",
        "faceIds": [
            "google-sans-latin-ext:400",
            "google-sans-latin-ext:500",
            "google-sans-latin-ext:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-latn",
        "assetFile": "latn.css",
        "representativeText": "Àéñçõ"
    },
    "pt-BR": {
        "locale": "pt-BR",
        "script": "Latn",
        "family": "Google Sans",
        "faceIds": [
            "google-sans-latin-ext:400",
            "google-sans-latin-ext:500",
            "google-sans-latin-ext:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-latn",
        "assetFile": "latn.css",
        "representativeText": "Àéñçõ"
    },
    "ru-RU": {
        "locale": "ru-RU",
        "script": "Cyrl",
        "family": "Google Sans",
        "faceIds": [
            "google-sans-cyrillic:400",
            "google-sans-cyrillic:500",
            "google-sans-cyrillic:700"
        ],
        "weights": [
            400,
            500,
            700
        ],
        "assetEntry": "font-script-cyrl",
        "assetFile": "cyrl.css",
        "representativeText": "Привет"
    }
} as const satisfies Readonly<Record<SupportedLocale, LocaleFontDescriptor>>);
export function getLocaleFontDescriptor(locale: SupportedLocale): LocaleFontDescriptor
{
    return LOCALE_FONT_CATALOG[locale];
}
