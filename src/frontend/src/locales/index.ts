import { computed, readonly, shallowRef } from 'vue';

import { enUS } from './en-US';
import {
    DEFAULT_LOCALE,
    LOCALE_PREFERENCE_STORAGE_KEY,
    isSupportedLocale,
    type DeepStringShape,
    type LeafPaths,
    type SupportedLocale,
    type TranslationParams
} from './keys';
import { zhCN } from './zh-CN';

export {
    DEFAULT_LOCALE,
    ENABLED_LOCALES,
    LOCALE_PREFERENCE_STORAGE_KEY,
    isSupportedLocale
} from './keys';
export type { SupportedLocale, TranslationParams } from './keys';
export {
    MIGRATION_PLACEHOLDER_PREFIX,
    enumeratePlaceholders,
    extractInterpolationParams,
    parseMigrationPlaceholder,
    validateLocaleParity
} from './validator';
export type { EnumeratedPlaceholder, MigrationPlaceholderInfo, ParityValidationResult } from './validator';

export type LocaleMessages = DeepStringShape<typeof zhCN>;
export type TranslationKey = LeafPaths<typeof zhCN>;

const localeMessages = {
    'zh-CN': zhCN,
    'en-US': enUS
} as const satisfies Record<SupportedLocale, LocaleMessages>;

const localeState = shallowRef<SupportedLocale>(DEFAULT_LOCALE);
let runtimeInitialized = false;
let storageListener: ((event: StorageEvent) => void) | null = null;

export const locale = readonly(localeState);
export const messages = computed<LocaleMessages>(() => localeMessages[localeState.value]);

export function getLocaleMessages(value: SupportedLocale): LocaleMessages
{
    return localeMessages[value];
}

function resolveMessage(dictionary: LocaleMessages, key: string): string | null
{
    let current: unknown = dictionary;
    for (const segment of key.split('.'))
    {
        if (!current || typeof current !== 'object' || !(segment in current))
        {
            return null;
        }
        current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === 'string' ? current : null;
}

function interpolate(message: string, params: TranslationParams = {}): string
{
    return message.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (token, key: string) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : token
    ));
}

export function translate(key: TranslationKey, params?: TranslationParams): string
{
    return translateUnsafe(key, params);
}

export function translateUnsafe(key: string, params?: TranslationParams): string
{
    const requestedLocale = localeState.value;
    const localized = resolveMessage(localeMessages[requestedLocale], key);
    if (localized !== null)
    {
        return interpolate(localized, params);
    }

    throw new Error(`i18n_missing_message:${requestedLocale}:${key}`);
}

function localeToOpenGraph(value: SupportedLocale): string
{
    return value.replace('-', '_');
}

export function syncLocaleDocumentMetadata(value: SupportedLocale = localeState.value): void
{
    if (typeof document === 'undefined')
    {
        return;
    }

    document.documentElement.lang = value;
    let openGraphLocale = document.head.querySelector<HTMLMetaElement>('meta[property="og:locale"]');
    if (!openGraphLocale)
    {
        openGraphLocale = document.createElement('meta');
        openGraphLocale.setAttribute('property', 'og:locale');
        document.head.appendChild(openGraphLocale);
    }
    openGraphLocale.content = localeToOpenGraph(value);
}

function applyLocale(value: SupportedLocale, persist: boolean): SupportedLocale
{
    localeState.value = value;
    if (persist && typeof localStorage !== 'undefined')
    {
        localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, value);
    }
    syncLocaleDocumentMetadata(value);
    if (typeof window !== 'undefined')
    {
        window.dispatchEvent(new CustomEvent('fsus:locale-change', { detail: { locale: value } }));
    }
    return value;
}

export function setLocale(value: SupportedLocale): SupportedLocale
{
    return applyLocale(value, true);
}

export function toggleLocale(): SupportedLocale
{
    return setLocale(localeState.value === 'zh-CN' ? 'en-US' : 'zh-CN');
}

export function initializeLocaleRuntime(initialLocale?: SupportedLocale): SupportedLocale
{
    if (runtimeInitialized)
    {
        if (initialLocale && initialLocale !== localeState.value)
        {
            return applyLocale(initialLocale, false);
        }
        syncLocaleDocumentMetadata();
        return localeState.value;
    }

    runtimeInitialized = true;
    const storedLocale = typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(LOCALE_PREFERENCE_STORAGE_KEY);
    const resolvedLocale = initialLocale ?? (isSupportedLocale(storedLocale) ? storedLocale : DEFAULT_LOCALE);

    if (typeof window !== 'undefined')
    {
        storageListener = (event: StorageEvent) =>
        {
            if (event.key === LOCALE_PREFERENCE_STORAGE_KEY && isSupportedLocale(event.newValue))
            {
                applyLocale(event.newValue, false);
            }
        };
        window.addEventListener('storage', storageListener);
    }

    return applyLocale(resolvedLocale, false);
}

export function formatDate(
    value: string | number | Date,
    options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
): string
{
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
    {
        return translate('common.time.invalid');
    }
    return new Intl.DateTimeFormat(localeState.value, options).format(date);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string
{
    return new Intl.NumberFormat(localeState.value, options).format(value);
}

export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string
{
    return new Intl.RelativeTimeFormat(localeState.value, { numeric: 'auto' }).format(value, unit);
}

export function resetLocaleRuntimeForTests(): void
{
    if (storageListener && typeof window !== 'undefined')
    {
        window.removeEventListener('storage', storageListener);
    }
    storageListener = null;
    runtimeInitialized = false;
    localeState.value = DEFAULT_LOCALE;
}
