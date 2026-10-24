import {
    computed,
    shallowRef,
    type App,
    type ComputedRef,
    type InjectionKey
} from 'vue';

import { getLocaleDescriptor, PLURAL_CATEGORIES } from './keys';
import { LOCALE_CATALOG_DIGEST } from './localeCatalog';
import { isLocaleDomain } from './localeDomains';
import {
    activateLocaleRuntime,
    activeLocale,
    beginLocaleRouteTransaction,
    getLocaleProjection,
    localeRuntimeState,
    messages,
    prepareLocaleDomains,
    PUBLIC_SHELL_LOCALE_DOMAINS,
    requestLocale,
    requestLocalePreference,
    resetLocaleRuntimeForTests as resetLocaleRuntimeCoordinatorForTests,
    type PreparedLocaleDomains
} from './runtime/localeRuntimeComposition';

import type {
    LocaleMessages,
    PluralCategory,
    PluralNode,
    PluralTranslationArguments,
    PluralTranslationKey,
    SupportedLocale,
    TranslationArguments,
    TranslationKey
} from './keys';

export { isSupportedLocale, parseSupportedLocale } from './keys';
export { DEFAULT_LOCALE } from './keys';
export type {
    LocaleMessages,
    PluralCategory,
    PluralNode,
    PluralParamsByKey,
    PluralTranslationArguments,
    PluralTranslationKey,
    SupportedLocale,
    TranslationArguments,
    TranslationKey,
    TranslationParamsByKey
} from './keys';
export { ENABLED_LOCALES } from './localeCatalog';
export { LOCALE_DOMAINS, isLocaleDomain, type LocaleDomain } from './localeDomains';
export {
    loadLocaleDomain,
    loadLocaleDomains,
    peekLocaleDomain,
    LocaleDomainBundleStore
} from './localeDomainBundleStore';

export {
    activateLocaleRuntime,
    activeLocale,
    beginLocaleRouteTransaction,
    localeRuntimeState,
    messages,
    prepareLocaleDomains,
    PUBLIC_SHELL_LOCALE_DOMAINS,
    requestLocale,
    requestLocalePreference
};

export type { PreparedLocaleDomains };

export type PreparedLocaleRouteTransaction = Readonly<{
    snapshot: PreparedLocaleDomains;
    commit: () => void;
    rollback: () => void;
}>;

export type LocaleTextContext = Readonly<{
    activeLocale: ComputedRef<SupportedLocale>;
    messages: ComputedRef<LocaleMessages>;
    translate: <Key extends TranslationKey>(
        key: Key,
        ...args: TranslationArguments<Key>
    ) => string;
    translatePlural: <Key extends PluralTranslationKey>(
        key: Key,
        ...args: PluralTranslationArguments<Key>
    ) => string;
    formatDate: (
        value: string | number | Date,
        options?: Intl.DateTimeFormatOptions
    ) => string;
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
    formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) => string;
}>;

export const LOCALE_TEXT_CONTEXT_KEY: InjectionKey<LocaleTextContext> =
    Symbol('fsusblog.locale-text-context');

type LocaleSnapshot = Pick<{ locale: SupportedLocale; messages: LocaleMessages; }, 'locale' | 'messages'>;

let pluralRulesCatalogDigest: string | null = null;
const pluralRulesByLocale = new Map<SupportedLocale, Intl.PluralRules>();

function clearPluralRulesCache(): void
{
    pluralRulesByLocale.clear();
    pluralRulesCatalogDigest = null;
}

/**
 * Cached Intl.PluralRules keyed only by exact SupportedLocale.
 * Catalog digest changes force reconstruction for tests/new builds.
 */
export function getPluralRulesForLocale(locale: SupportedLocale): Intl.PluralRules
{
    if (pluralRulesCatalogDigest !== LOCALE_CATALOG_DIGEST)
    {
        pluralRulesByLocale.clear();
        pluralRulesCatalogDigest = LOCALE_CATALOG_DIGEST;
    }
    const cached = pluralRulesByLocale.get(locale);
    if (cached)
    {
        return cached;
    }
    const rules = new Intl.PluralRules(getLocaleDescriptor(locale).intlLocale);
    pluralRulesByLocale.set(locale, rules);
    return rules;
}

function resolveLeaf(dictionary: LocaleMessages, key: string): unknown
{
    let current: unknown = dictionary;
    for (const segment of key.split('.'))
    {
        if (!current || typeof current !== 'object' || !(segment in current))
        {
            return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

/** Ordinary messages only — plural objects never resolve as strings. */
function resolveMessage(dictionary: LocaleMessages, key: string): string | null
{
    const leaf = resolveLeaf(dictionary, key);
    return typeof leaf === 'string' ? leaf : null;
}

function isDiscriminatedPluralNode(value: unknown): value is PluralNode
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    if (Reflect.get(value, 'kind') !== 'plural')
    {
        return false;
    }
    const forms = Reflect.get(value, 'forms');
    return !!forms && typeof forms === 'object' && !Array.isArray(forms);
}

function interpolate(message: string, params: Record<string, string | number> = {}): string
{
    return message.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (token, key: string) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : token);
}

function extractInterpolationParams(message: string): string[]
{
    const matches = message.match(/\{([A-Za-z][A-Za-z0-9]*)\}/gu);
    if (!matches)
    {
        return [];
    }
    return Array.from(new Set(matches.map((match) => match.slice(1, -1)))).sort();
}

function translateFrom<Key extends TranslationKey>(
    snapshot: LocaleSnapshot,
    key: Key,
    ...args: TranslationArguments<Key>
): string
{
    const localized = resolveMessage(snapshot.messages, key);
    if (localized !== null)
    {
        return interpolate(localized, args[0]);
    }
    throw new Error(`i18n_missing_message:${snapshot.locale}:${key}`);
}

function translatePluralFrom<Key extends PluralTranslationKey>(
    snapshot: LocaleSnapshot,
    key: Key,
    ...args: PluralTranslationArguments<Key>
): string
{
    const count = args[0];
    const params = args[1] as Record<string, string | number> | undefined;

    if (typeof count !== 'number' || !Number.isFinite(count))
    {
        throw new Error(`plural_count_invalid:${snapshot.locale}:${key}:${String(count)}`);
    }

    const domainSegment = key.split('.')[0] ?? '';
    if (!isLocaleDomain(domainSegment) || !(domainSegment in snapshot.messages))
    {
        throw new Error(`plural_key_domain_not_loaded:${snapshot.locale}:${domainSegment}:${key}`);
    }

    if (params && Object.prototype.hasOwnProperty.call(params, 'count'))
    {
        throw new Error(`plural_count_conflict:${snapshot.locale}:${key}`);
    }

    const leaf = resolveLeaf(snapshot.messages, key);
    if (!isDiscriminatedPluralNode(leaf))
    {
        throw new Error(`plural_node_invalid:${snapshot.locale}:${key}`);
    }

    const category = getPluralRulesForLocale(snapshot.locale).select(count);
    if (!PLURAL_CATEGORIES.includes(category))
    {
        throw new Error(`plural_category_missing:${snapshot.locale}:${key}:${String(category)}`);
    }

    const form = leaf.forms[category];
    if (typeof form !== 'string')
    {
        // `other` is only valid when Intl actually selects other — never a missing-category fallback.
        throw new Error(`plural_category_missing:${snapshot.locale}:${key}:${category}`);
    }

    for (const name of extractInterpolationParams(form))
    {
        if (name === 'count')
        {
            continue;
        }
        if (!params || !Object.prototype.hasOwnProperty.call(params, name))
        {
            throw new Error(`plural_parameter_missing:${snapshot.locale}:${key}:${name}`);
        }
    }

    const merged: Record<string, string | number> = params ? { ...params, count } : { count };
    return interpolate(form, merged);
}

export function translate<Key extends TranslationKey>(
    key: Key,
    ...args: TranslationArguments<Key>
): string
{
    return translateFrom(getLocaleProjection(), key, ...args);
}

export function translatePlural<Key extends PluralTranslationKey>(
    key: Key,
    ...args: PluralTranslationArguments<Key>
): string
{
    return translatePluralFrom(getLocaleProjection(), key, ...args);
}

function formatDateForLocale(
    snapshot: LocaleSnapshot,
    value: string | number | Date,
    options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
): string
{
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
    {
        return translateFrom(snapshot, 'common.time.invalid');
    }
    return new Intl.DateTimeFormat(
        getLocaleDescriptor(snapshot.locale).intlLocale,
        options
    ).format(date);
}

export function createLocaleTextContext(snapshot: PreparedLocaleDomains): LocaleTextContext
{
    const scopedProjection = shallowRef(Object.freeze({
        initialized: true,
        locale: snapshot.locale,
        domains: snapshot.domains,
        messages: snapshot.messages,
        revision: 1
    }));
    const scopedLocale = computed(() => scopedProjection.value.locale);
    const scopedMessages = computed(() => scopedProjection.value.messages);
    return Object.freeze({
        activeLocale: scopedLocale,
        messages: scopedMessages,
        translate: <Key extends TranslationKey>(
            key: Key,
            ...args: TranslationArguments<Key>
        ) => translateFrom(scopedProjection.value, key, ...args),
        translatePlural: <Key extends PluralTranslationKey>(
            key: Key,
            ...args: PluralTranslationArguments<Key>
        ) => translatePluralFrom(scopedProjection.value, key, ...args),
        formatDate: (
            value: string | number | Date,
            options?: Intl.DateTimeFormatOptions
        ) => formatDateForLocale(scopedProjection.value, value, options),
        formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
            new Intl.NumberFormat(
                getLocaleDescriptor(scopedProjection.value.locale).intlLocale,
                options
            ).format(value),
        formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) =>
            new Intl.RelativeTimeFormat(
                getLocaleDescriptor(scopedProjection.value.locale).intlLocale,
                { numeric: 'auto' }
            ).format(value, unit)
    });
}

export function resetLocaleRuntimeForTests(
    ...args: Parameters<typeof resetLocaleRuntimeCoordinatorForTests>
): void
{
    clearPluralRulesCache();
    resetLocaleRuntimeCoordinatorForTests(...args);
}

export function provideLocaleTextContext(
    app: Pick<App, 'provide'>,
    snapshot: PreparedLocaleDomains
): void
{
    app.provide(LOCALE_TEXT_CONTEXT_KEY, createLocaleTextContext(snapshot));
}

export function formatDate(
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions
): string
{
    return formatDateForLocale(getLocaleProjection(), value, options);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string
{
    return new Intl.NumberFormat(
        getLocaleDescriptor(getLocaleProjection().locale).intlLocale,
        options
    ).format(value);
}

export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string
{
    return new Intl.RelativeTimeFormat(
        getLocaleDescriptor(getLocaleProjection().locale).intlLocale,
        { numeric: 'auto' }
    ).format(value, unit);
}
