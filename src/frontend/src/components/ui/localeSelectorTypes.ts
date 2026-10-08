/**
 * Blog-owned LocaleSelector projection contract.
 * Callers project #1704 catalog descriptors into these items; the component never
 * imports the locale runtime, registry, router, storage, or account APIs.
 */
export type LocaleSelectorDirection = 'ltr' | 'rtl';

export type LocaleSelectorItem = Readonly<{
    code: string;
    nativeName: string;
    englishName: string;
    direction: LocaleSelectorDirection;
    selected: boolean;
    /** Progressive-enhancement target supplied by the caller when available. */
    href?: string;
}>;

export type LocaleSelectorProps = Readonly<{
    items: readonly LocaleSelectorItem[];
    activeLocale: string;
    pendingLocale?: string | null;
    /** Failed request target; independent of the committed and pending locale. */
    retryLocale?: string | null;
    /** Controlled open state. Omit for internal open ownership. */
    open?: boolean;
    disabled?: boolean;
    errorMessage?: string | null;
    compact?: boolean;
}>;
