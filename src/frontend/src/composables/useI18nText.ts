import { hasInjectionContext, inject } from 'vue';

import {
    ENABLED_LOCALES,
    formatDate,
    formatNumber,
    formatRelativeTime,
    activateLocaleRuntime,
    activeLocale,
    messages,
    LOCALE_TEXT_CONTEXT_KEY,
    requestLocale,
    translate,
    translatePlural,
    type PluralTranslationArguments,
    type PluralTranslationKey,
    type TranslationArguments,
    type TranslationKey
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
        activateLocaleRuntime,
        requestLocale,
        t: <Key extends TranslationKey>(key: Key, ...params: TranslationArguments<Key>) =>
            scoped ? scoped.translate(key, ...params) : translate(key, ...params),
        translatePlural: <Key extends PluralTranslationKey>(
            key: Key,
            ...params: PluralTranslationArguments<Key>
        ) => scoped
            ? scoped.translatePlural(key, ...params)
            : translatePlural(key, ...params),
        formatDate: scoped?.formatDate ?? formatDate,
        formatNumber: scoped?.formatNumber ?? formatNumber,
        formatRelativeTime: scoped?.formatRelativeTime ?? formatRelativeTime
    };
}
