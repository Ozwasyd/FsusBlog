import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { projectLocaleSelectorItems } from '@/components/i18n/projectLocaleSelectorItems';
import type { LocaleSelectorItem } from '@/components/ui/localeSelectorTypes';
import { useI18nText } from '@/composables/useI18nText';
import {
    ENABLED_LOCALES,
    isSupportedLocale,
    localeRuntimeState,
    requestLocalePreference,
    type SupportedLocale
} from '@/locales';

export type LocaleSelectorRuntimeProjection = Readonly<{
    activeLocale: ComputedRef<SupportedLocale>;
    items: ComputedRef<readonly LocaleSelectorItem[]>;
    pendingLocale: ComputedRef<string | null>;
    retryLocale: ComputedRef<string | null>;
    errorMessage: ComputedRef<string | null>;
    menuOpen: Ref<boolean>;
    handleOpenChange: (open: boolean) => void;
    handleSelect: (locale: string) => void;
    handleRetry: (locale: string) => void;
    commitFixedLocale: (locale: string) => Promise<void>;
}>;

/**
 * Cross-layout composition adapter core: projects catalog + runtime state into
 * LocaleSelector props and routes selection through the #1527/#1706 transaction.
 */
export function useLocaleSelectorRuntime(): LocaleSelectorRuntimeProjection
{
    /**
   * useI18nText prefers request-scoped AOT/SSR projection when provided, then the
   * global runtime active locale after client activation / explicit switches.
   */
    const { activeLocale } = useI18nText();

    const items = computed(() => projectLocaleSelectorItems(activeLocale.value));

    const pendingLocale = computed(() =>
    {
        const state = localeRuntimeState.value;
        return state.preparing?.target
      ?? state.committing?.target
      ?? null;
    });

    /**
   * Selector-owned failure target. Prefer matching runtime.failed when present;
   * still project a catalog nativeName after a local catch so the selector error
   * surface works without new translation keys.
   */
    const lastFailedTarget = ref<SupportedLocale | null>(null);
    const retryLocale = computed(() => lastFailedTarget.value);
    let selectionGeneration = 0;

    const errorMessage = computed(() =>
    {
        if (!lastFailedTarget.value || pendingLocale.value)
        {
            return null;
        }
        const failed = localeRuntimeState.value.failed;
        if (failed && failed.target !== lastFailedTarget.value)
        {
            return null;
        }
        const target = lastFailedTarget.value;
        const descriptor = ENABLED_LOCALES.find((entry) => entry.code === target);
        return descriptor?.nativeName ?? target;
    });

    const menuOpen = ref(false);

    function handleOpenChange(open: boolean): void
    {
        menuOpen.value = open;
    }

    async function commitFixedLocale(code: string): Promise<void>
    {
        if (!isSupportedLocale(code))
        {
            return;
        }

        const generation = ++selectionGeneration;

        if (code === activeLocale.value && !errorMessage.value && !pendingLocale.value)
        {
            menuOpen.value = false;
            return;
        }

        lastFailedTarget.value = null;
        try
        {
            await requestLocalePreference({ mode: 'fixed', locale: code });
            if (generation !== selectionGeneration)
            {
                return;
            }
            lastFailedTarget.value = null;
            menuOpen.value = false;
        }
        catch
        {
            if (generation !== selectionGeneration)
            {
                return;
            }
            lastFailedTarget.value = code;
            // Keep menu open so pending progress / error + retry stay reachable.
        }
    }

    function handleSelect(locale: string): void
    {
        void commitFixedLocale(locale);
    }

    function handleRetry(locale: string): void
    {
        void commitFixedLocale(locale);
    }

    return Object.freeze({
        activeLocale,
        items,
        pendingLocale,
        retryLocale,
        errorMessage,
        menuOpen,
        handleOpenChange,
        handleSelect,
        handleRetry,
        commitFixedLocale
    });
}
