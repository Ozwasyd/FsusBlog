import { computed } from 'vue';

import {
    ENABLED_LOCALES,
    formatDate,
    formatNumber,
    formatRelativeTime,
    initializeLocaleRuntime,
    locale,
    messages,
    setLocale,
    toggleLocale,
    translate,
    type TranslationKey,
    type TranslationParams
} from '@/locales';

export function useI18nText()
{
    const isEnglish = computed(() => locale.value === 'en-US');

    return {
        enabledLocales: ENABLED_LOCALES,
        locale,
        messages,
        isEnglish,
        initializeLocaleRuntime,
        setLocale,
        toggleLocale,
        t: (key: TranslationKey, params?: TranslationParams) => translate(key, params),
        formatDate,
        formatNumber,
        formatRelativeTime
    };
}
