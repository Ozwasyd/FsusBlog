import { computed, shallowRef, type ComputedRef, type ShallowRef } from 'vue';

import {
    getLocalePreference,
    updateLocalePreference
} from '@/api/auth';
import { fontPreparationPort } from '@/bootstrap/fontPreparationPort';
import type { UserLocalePreference } from '@/contracts/binaryApi';
import { emitTelemetry } from '@/services/telemetryBus';
import { toAppError } from '@/utils/appError';

import { syncLocaleDocumentMetadata } from '../documentMetadata';
import {
    DEFAULT_LOCALE,
    getLocaleDescriptor,
    isSupportedLocale,
    parseSupportedLocale,
    type LocaleMessages,
    type SupportedLocale
} from '../keys';
import { loadLocaleDomains } from '../localeDomainBundleStore';
import { LOCALE_FONT_WEIGHTS } from '../localeFontCatalog';

import {
    LocaleRuntimeCoordinator,
    type LocaleFontPreparationReceipt,
    type LocalePreferenceCommitCommand,
    type LocalePreferenceCommitReceipt,
    type LocaleRuntimeOutcome,
    type LocaleRuntimePorts,
    type LocaleRuntimeState,
    type LocaleRouteTransaction,
    type PreparedLocaleDomains
} from './localeRuntimeCoordinator';

import type { LocaleDomain } from '../localeDomains';

export type {
    LocaleRouteTransaction,
    LocaleRuntimeOutcome,
    LocaleRuntimeState,
    PreparedLocaleDomains
};

const EMPTY_MESSAGES = Object.freeze({}) as LocaleMessages;

export const PUBLIC_SHELL_LOCALE_DOMAINS = Object.freeze([
    'common',
    'layout',
    'public'
] as const satisfies readonly LocaleDomain[]);

type LocaleProjection = Readonly<{
    initialized: boolean;
    locale: SupportedLocale;
    domains: readonly LocaleDomain[];
    messages: LocaleMessages;
    revision: number;
}>;

const projectionState: ShallowRef<LocaleProjection> = shallowRef(Object.freeze({
    initialized: false,
    locale: DEFAULT_LOCALE,
    domains: PUBLIC_SHELL_LOCALE_DOMAINS,
    messages: EMPTY_MESSAGES,
    revision: 0
}));

const runtimeState: ShallowRef<LocaleRuntimeState> = shallowRef(Object.freeze({
    active: null,
    preparing: null,
    committing: null,
    failed: null
}));

const preferenceSnapshot: ShallowRef<UserLocalePreference | null> = shallowRef(null);

export const activeLocale: ComputedRef<SupportedLocale> = computed(
    () => projectionState.value.locale
);
export const messages: ComputedRef<LocaleMessages> = computed(
    () => projectionState.value.messages
);
export const localeRuntimeState: ComputedRef<LocaleRuntimeState> = computed(
    () => runtimeState.value
);

function abortError(): DOMException
{
    return new DOMException('Locale transaction aborted', 'AbortError');
}

function normalizeDomains(domains: readonly LocaleDomain[]): readonly LocaleDomain[]
{
    return Object.freeze([...new Set(domains)]);
}

function assertPreparedSnapshot(snapshot: PreparedLocaleDomains): void
{
    if (snapshot.domains.length !== snapshot.identities.length)
    {
        throw new Error(`i18n_snapshot_identity_count_drift:${snapshot.locale}`);
    }
    for (let index = 0; index < snapshot.domains.length; index += 1)
    {
        const domain = snapshot.domains[index];
        const identity = snapshot.identities[index];
        if (
            !domain
      || identity?.locale !== snapshot.locale
      || identity.domain !== domain
      || !(domain in snapshot.messages)
        )
        {
            throw new Error(`i18n_snapshot_identity_drift:${snapshot.locale}:${String(domain)}`);
        }
    }
}

/**
 * Pure domain preparation boundary used by SSR, AOT, and the runtime port.
 * Never mutates active locale, metadata, preference, or events.
 */
export async function prepareLocaleDomains(
    value: SupportedLocale,
    domains: readonly LocaleDomain[],
    signal?: AbortSignal
): Promise<PreparedLocaleDomains>
{
    if (!isSupportedLocale(value))
    {
        throw new Error(`unsupported_locale:${String(value)}`);
    }
    if (signal?.aborted)
    {
        throw abortError();
    }

    const normalizedDomains = normalizeDomains(domains);
    const artifacts = await loadLocaleDomains(value, normalizedDomains, signal);
    const entries = normalizedDomains.map((domain) =>
    {
        const artifact = artifacts[domain];
        if (!artifact)
        {
            throw new Error(`i18n_unprepared_domain:${value}:${domain}`);
        }
        return [domain, artifact] as const;
    });
    const snapshot = Object.freeze({
        locale: value,
        domains: normalizedDomains,
        messages: Object.freeze(Object.fromEntries(entries)) as LocaleMessages,
        identities: Object.freeze(normalizedDomains.map((domain) =>
            Object.freeze({ locale: value, domain })))
    });
    assertPreparedSnapshot(snapshot);
    return snapshot;
}

function resolveAcceptLanguageLocale(
    languageTags: readonly string[]
): SupportedLocale
{
    for (const tag of languageTags)
    {
        const normalized = tag.trim();
        if (!normalized)
        {
            continue;
        }
        let candidate = normalized;
        while (true)
        {
            const parsed = parseSupportedLocale(candidate);
            if (parsed)
            {
                return parsed;
            }
            const separator = candidate.lastIndexOf('-');
            if (separator <= 0)
            {
                break;
            }
            candidate = candidate.slice(0, separator);
        }
    }
    return DEFAULT_LOCALE;
}

function readNavigatorLanguageTags(): readonly string[]
{
    if (typeof navigator === 'undefined')
    {
        return Object.freeze([]);
    }
    const languages: readonly string[] = Array.isArray(navigator.languages) ? navigator.languages : [];
    if (languages.length > 0)
    {
        return Object.freeze([...languages]);
    }
    if (typeof navigator.language === 'string' && navigator.language)
    {
        return Object.freeze([navigator.language]);
    }
    return Object.freeze([]);
}

async function commitPreference(
    command: LocalePreferenceCommitCommand,
    signal?: AbortSignal
): Promise<LocalePreferenceCommitReceipt>
{
    const current = preferenceSnapshot.value;
    const expectedRevision = current?.revision ?? 0;
    try
    {
        const snapshot = await updateLocalePreference({
            mode: command.mode,
            fixedLocale: command.mode === 'fixed' ? command.locale : null,
            expectedRevision
        }, { signal });
        preferenceSnapshot.value = snapshot;
        const effectiveLocale = snapshot.mode === 'fixed' && snapshot.fixedLocale
            ? snapshot.fixedLocale
            : resolveAcceptLanguageLocale(readNavigatorLanguageTags());
        return Object.freeze({
            mode: snapshot.mode,
            fixedLocale: snapshot.fixedLocale,
            effectiveLocale,
            revision: snapshot.revision
        });
    }
    catch (error)
    {
        throw toAppError(error, 'locale_preference_unavailable');
    }
}

function applyActiveProjection(state: LocaleRuntimeState): void
{
    runtimeState.value = state;
    const active = state.active;
    if (!active)
    {
        return;
    }
    const current = projectionState.value;
    if (
        current.initialized
    && current.locale === active.locale
    && current.messages === active.messages
    && current.domains === active.loadedDomains
    )
    {
        return;
    }
    projectionState.value = Object.freeze({
        initialized: true,
        locale: active.locale,
        domains: active.loadedDomains,
        messages: active.messages,
        revision: current.revision + 1
    });
}

function createDefaultPorts(
    overrides?: Partial<LocaleRuntimePorts>
): LocaleRuntimePorts
{
    const fontWeights = (overrides?.fontWeights ?? LOCALE_FONT_WEIGHTS);
    return Object.freeze({
        domainBundlePort: overrides?.domainBundlePort ?? Object.freeze({
            prepareLocaleDomains
        }),
        fontPreparationPort: overrides?.fontPreparationPort ?? Object.freeze({
            prepareLocaleFonts: async (locale, weights, signal) =>
            {
                const receipt = await fontPreparationPort.prepareLocaleFonts(
                    locale,
                    weights,
                    signal
                );
                return Object.freeze({
                    locale: receipt.locale,
                    generation: receipt.generation
                });
            }
        }),
        preferenceCommitPort: overrides?.preferenceCommitPort ?? Object.freeze({
            commit: commitPreference
        }),
        metadataPort: overrides?.metadataPort ?? Object.freeze({
            commitDocumentMetadata: syncLocaleDocumentMetadata
        }),
        clock: overrides?.clock ?? Object.freeze({
            now: () => (
        typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now()
            )
        }),
        telemetryPort: overrides?.telemetryPort ?? Object.freeze({
            phase: (from, to, state, durationMs) => emitTelemetry('locale_runtime_phase', {
                durationMs,
                from,
                to,
                generation: state.active?.generation
          ?? state.preparing?.generation
          ?? state.committing?.generation
          ?? state.failed?.generation
          ?? 0,
                locale: state.active?.locale
          ?? state.preparing?.target
          ?? state.committing?.target
          ?? state.failed?.target
            }, 'info'),
            failed: (failed) => emitTelemetry('locale_runtime_failed', {
                generation: failed.generation,
                reason: failed.reason,
                target: failed.target
            }, 'warn'),
            committed: (active) => emitTelemetry('locale_runtime_committed', {
                generation: active.generation,
                locale: active.locale,
                domains: [...active.loadedDomains]
            }, 'info')
        }),
        fontWeights,
        onStateChange: (state) =>
        {
            applyActiveProjection(state);
            overrides?.onStateChange?.(state);
        }
    });
}

function createTestPorts(
    overrides?: Partial<LocaleRuntimePorts>
): Partial<LocaleRuntimePorts>
{
    return {
        fontPreparationPort: overrides?.fontPreparationPort ?? Object.freeze({
            prepareLocaleFonts: (locale) => new Promise<LocaleFontPreparationReceipt>((resolve) =>
            {
                resolve(Object.freeze({
                    locale,
                    generation: 1
                }));
            })
        }),
        preferenceCommitPort: overrides?.preferenceCommitPort ?? Object.freeze({
            commit: (command) => new Promise<LocalePreferenceCommitReceipt>((resolve) =>
            {
                const effectiveLocale = command.mode === 'fixed'
                    ? command.locale
                    : resolveAcceptLanguageLocale(readNavigatorLanguageTags());
                const snapshot = Object.freeze({
                    mode: command.mode,
                    fixedLocale: command.mode === 'fixed' ? command.locale : null,
                    revision: (preferenceSnapshot.value?.revision ?? 0) + 1,
                    updatedAt: new Date(0).toISOString()
                }) satisfies UserLocalePreference;
                preferenceSnapshot.value = snapshot;
                resolve(Object.freeze({
                    mode: snapshot.mode,
                    fixedLocale: snapshot.fixedLocale,
                    effectiveLocale,
                    revision: snapshot.revision
                }));
            })
        }),
        ...overrides
    };
}

let coordinator = new LocaleRuntimeCoordinator(createDefaultPorts());

function outcomeLocale(outcome: LocaleRuntimeOutcome, requested: SupportedLocale): SupportedLocale
{
    if (outcome.status === 'active')
    {
        return outcome.locale;
    }
    if (outcome.status === 'superseded')
    {
        const active = coordinator.snapshot().active;
        // Same-target joiners may observe a later generation commit; treat that as
        // success. A different winning target must not look like the caller's commit.
        if (active?.locale === requested)
        {
            return active.locale;
        }
        throw abortError();
    }
    throw new Error(outcome.reason);
}

function resolveInitialLocale(initialLocale?: SupportedLocale): SupportedLocale
{
    if (initialLocale)
    {
        if (!isSupportedLocale(initialLocale))
        {
            throw new Error(`unsupported_locale:${String(initialLocale)}`);
        }
        return initialLocale;
    }
    const documentLocale = typeof document === 'undefined'
        ? null
        : document.documentElement.lang;
    if (isSupportedLocale(documentLocale))
    {
        return documentLocale;
    }
    throw new Error('locale_runtime_initial_locale_missing');
}

/**
 * Client bootstrap from server-resolved locale only. Never re-decides locale and
 * never persists preference. Fail closed when critical domains cannot load.
 */
export async function activateLocaleRuntime(
    initialLocale?: SupportedLocale,
    domains: readonly LocaleDomain[] = PUBLIC_SHELL_LOCALE_DOMAINS
): Promise<SupportedLocale>
{
    const resolvedLocale = resolveInitialLocale(initialLocale);
    const outcome = await coordinator.activateInitial(resolvedLocale, domains);
    return outcomeLocale(outcome, resolvedLocale);
}

/**
 * Explicit runtime locale switch. Domains default to the current active set.
 * Preference persistence is opt-in so navigation does not rewrite cookies; the
 * preference command port uses persistPreference / requestLocalePreference.
 */
export async function requestLocale(
    value: SupportedLocale,
    requiredDomains?: readonly LocaleDomain[],
    options?: Readonly<{ persistPreference?: boolean; }>
): Promise<SupportedLocale>
{
    if (!isSupportedLocale(value))
    {
        throw new Error(`unsupported_locale:${String(value)}`);
    }
    // When domains are omitted, the coordinator re-reads the active domain set
    // under the commit mutex so concurrent route expansions are not lost.
    const outcome = await coordinator.requestLocale(
        value,
        requiredDomains ?? (
      projectionState.value.initialized
          ? undefined
          : PUBLIC_SHELL_LOCALE_DOMAINS
        ),
        options
    );
    return outcomeLocale(outcome, value);
}

export async function requestLocalePreference(
    command: LocalePreferenceCommitCommand,
    requiredDomains?: readonly LocaleDomain[]
): Promise<SupportedLocale>
{
    const domains = requiredDomains
    ?? (projectionState.value.initialized
        ? projectionState.value.domains
        : PUBLIC_SHELL_LOCALE_DOMAINS);
    const fallback = command.mode === 'fixed' ? command.locale : projectionState.value.locale;
    const outcome = await coordinator.requestLocalePreference(command, domains);
    return outcomeLocale(outcome, fallback);
}

export async function beginLocaleRouteTransaction(
    domains: readonly LocaleDomain[],
    signal?: AbortSignal
): Promise<LocaleRouteTransaction>
{
    return coordinator.beginRouteTransaction(domains, signal);
}

export function getLocaleProjection(): LocaleProjection
{
    return projectionState.value;
}

export function getPreferenceSnapshot(): UserLocalePreference | null
{
    return preferenceSnapshot.value;
}

export function setPreferenceSnapshotForTests(
    snapshot: UserLocalePreference | null
): void
{
    preferenceSnapshot.value = snapshot;
}

export async function refreshPreferenceSnapshot(
    signal?: AbortSignal
): Promise<UserLocalePreference>
{
    const snapshot = await getLocalePreference({ signal });
    preferenceSnapshot.value = snapshot;
    return snapshot;
}

export function describeActiveIntlLocale(): string
{
    return getLocaleDescriptor(projectionState.value.locale).intlLocale;
}

export function resetLocaleRuntimeForTests(
    ports?: Partial<LocaleRuntimePorts>
): void
{
    coordinator.resetForTests();
    preferenceSnapshot.value = null;
    projectionState.value = Object.freeze({
        initialized: false,
        locale: DEFAULT_LOCALE,
        domains: PUBLIC_SHELL_LOCALE_DOMAINS,
        messages: EMPTY_MESSAGES,
        revision: projectionState.value.revision + 1
    });
    runtimeState.value = Object.freeze({
        active: null,
        preparing: null,
        committing: null,
        failed: null
    });
    coordinator = new LocaleRuntimeCoordinator(
        createDefaultPorts(createTestPorts(ports))
    );
}
