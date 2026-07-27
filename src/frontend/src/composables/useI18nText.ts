import { hasInjectionContext, inject } from 'vue';
import {
    ENABLED_LOCALES,
    formatDate,
    formatNumber,
    formatRelativeTime,
    initializeLocaleRuntime,
    activeLocale,
    messages,
    LOCALE_TEXT_CONTEXT_KEY,
    requestLocale,
    translate,
    type TranslationArguments,
    type TranslationKey,
} from '@/locales';

export function useI18nText()
{
    const scoped = hasInjectionContext()
        ? inject(LOCALE_TEXT_CONTEXT_KEY, null)
        : null;
    return {
        enabledLocales: ENABLED_LOCALES,
        activeLocale: scoped?.activeLocale ?? activeLocale,
        messages: scoped?.messages ?? messages,
        initializeLocaleRuntime,
        requestLocale,
        t: <Key extends TranslationKey>(key: Key, ...params: TranslationArguments<Key>) =>
            scoped ? scoped.translate(key, ...params) : translate(key, ...params),
        formatDate: scoped?.formatDate ?? formatDate,
        formatNumber: scoped?.formatNumber ?? formatNumber,
        formatRelativeTime: scoped?.formatRelativeTime ?? formatRelativeTime
    };
}
