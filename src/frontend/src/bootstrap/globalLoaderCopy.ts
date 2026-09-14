import { DEFAULT_LOCALE, isSupportedLocale, type SupportedLocale } from '@/locales/localeCatalog';

/** Semantic key used by the global loader status live region. */
export const GLOBAL_LOADER_STATUS_KEY = 'common.loading.statusWithSite' as const;

/**
 * Bootstrap-only loading copy table.
 *
 * Must not statically import locale domain modules: that would pull every
 * catalog×common dictionary into the initial client graph. Values are kept
 * byte-equal to each locale's `common.loading.*` leaves and are fail-closed
 * by `tools/frontend/check-locale-domain-static.mjs`.
 */
export const GLOBAL_LOADER_COPY: Readonly<
    Record<SupportedLocale, Readonly<{ status: string; statusWithSite: string; }>>
> = Object.freeze({
    'zh-CN': Object.freeze({
        status: '正在加载',
        statusWithSite: '正在加载 {siteTitle}'
    }),
    'en-US': Object.freeze({
        status: 'Loading',
        statusWithSite: 'Loading {siteTitle}'
    }),
    'zh-Hant': Object.freeze({
        status: '正在載入',
        statusWithSite: '正在載入 {siteTitle}'
    }),
    'ja-JP': Object.freeze({
        status: '読み込み中',
        statusWithSite: '{siteTitle} を読み込み中'
    }),
    'ko-KR': Object.freeze({
        status: '로드 중',
        statusWithSite: '{siteTitle} 로드 중'
    }),
    'es-419': Object.freeze({
        status: 'Cargando',
        statusWithSite: 'Cargando {siteTitle}'
    }),
    'fr-FR': Object.freeze({
        status: 'Chargement',
        statusWithSite: 'Chargement de {siteTitle}'
    }),
    'de-DE': Object.freeze({
        status: 'Wird geladen',
        statusWithSite: '{siteTitle} wird geladen'
    }),
    'pt-BR': Object.freeze({
        status: 'Carregando',
        statusWithSite: 'Carregando {siteTitle}'
    }),
    'ru-RU': Object.freeze({
        status: 'Загрузка',
        statusWithSite: 'Загрузка {siteTitle}'
    })
});

function resolveDocumentLocale(): SupportedLocale
{
    if (typeof document === 'undefined')
    {
        return DEFAULT_LOCALE;
    }
    const raw = document.documentElement.lang?.trim();
    if (raw && isSupportedLocale(raw))
    {
        return raw;
    }
    return DEFAULT_LOCALE;
}

export function resolveGlobalLoaderStatus(siteTitle: string): string
{
    const copy = GLOBAL_LOADER_COPY[resolveDocumentLocale()] ?? GLOBAL_LOADER_COPY[DEFAULT_LOCALE];
    return copy.statusWithSite.replace(/\{siteTitle\}/gu, siteTitle);
}
