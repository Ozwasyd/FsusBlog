import type { LocaleMessages, SupportedLocale } from './keys'

export const LOCALE_BUNDLE_LOADERS: Readonly<Record<SupportedLocale, () => Promise<LocaleMessages>>> = {
    'zh-CN': () => import('./zh-CN').then(m => m.zhCN),
    'en-US': () => import('./en-US').then(m => m.enUS),
    'zh-Hant': () => import('./zh-Hant').then(m => m.zhHant),
    'ja-JP': () => import('./ja-JP').then(m => m.jaJP),
    'ko-KR': () => import('./ko-KR').then(m => m.koKR),
    'es-419': () => import('./es-419').then(m => m.es419),
    'fr-FR': () => import('./fr-FR').then(m => m.frFR),
    'de-DE': () => import('./de-DE').then(m => m.deDE),
    'pt-BR': () => import('./pt-BR').then(m => m.ptBR),
    'ru-RU': () => import('./ru-RU').then(m => m.ruRU)
} as const

const CACHE = new Map<SupportedLocale, LocaleMessages>()

export function hasBundle(code: SupportedLocale): boolean { return code in LOCALE_BUNDLE_LOADERS }

export function getCachedBundle(code: SupportedLocale): LocaleMessages | undefined {
    return CACHE.get(code)
}

export function evictBundle(code: SupportedLocale): void {
    CACHE.delete(code)
}

export async function loadBundle(code: SupportedLocale): Promise<LocaleMessages> {
    const cached = CACHE.get(code)
    if (cached) return cached

    const bundle = await LOCALE_BUNDLE_LOADERS[code]()
    CACHE.set(code, bundle)
    return bundle
}
