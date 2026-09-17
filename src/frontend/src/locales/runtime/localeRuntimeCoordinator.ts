import { DEFAULT_LOCALE, type LocaleMessages, type SupportedLocale } from '../keys';

import type { LocaleDomain } from '../localeDomains';
import type { LocaleFontWeight } from '../localeFontCatalog';

export type PreparedLocaleDomains = Readonly<{
    locale: SupportedLocale;
    domains: readonly LocaleDomain[];
    messages: LocaleMessages;
    identities: readonly Readonly<{
        locale: SupportedLocale;
        domain: LocaleDomain;
    }>[];
}>;

export type LocaleFontPreparationReceipt = Readonly<{
    locale: SupportedLocale;
    generation: number;
}>;

export type LocalePreferenceCommitCommand =
  | Readonly<{ mode: 'fixed'; locale: SupportedLocale; }>
  | Readonly<{ mode: 'auto'; }>;

export type LocalePreferenceCommitReceipt = Readonly<{
    mode: 'auto' | 'fixed';
    fixedLocale: SupportedLocale | null;
    effectiveLocale: SupportedLocale;
    revision: number;
}>;

export type LocaleRuntimeActive = Readonly<{
    locale: SupportedLocale;
    loadedDomains: readonly LocaleDomain[];
    generation: number;
    messages: LocaleMessages;
}>;

export type LocaleRuntimePreparing = Readonly<{
    target: SupportedLocale;
    requiredDomains: readonly LocaleDomain[];
    generation: number;
}>;

export type LocaleRuntimeCommitting = Readonly<{
    target: SupportedLocale;
    generation: number;
}>;

export type LocaleRuntimeFailed = Readonly<{
    target: SupportedLocale;
    generation: number;
    reason: string;
}>;

export type LocaleRuntimeState = Readonly<{
    active: LocaleRuntimeActive | null;
    preparing: LocaleRuntimePreparing | null;
    committing: LocaleRuntimeCommitting | null;
    failed: LocaleRuntimeFailed | null;
}>;

export type LocaleRuntimeOutcome =
  | Readonly<{ status: 'active'; generation: number; locale: SupportedLocale; }>
  | Readonly<{ status: 'failed'; generation: number; target: SupportedLocale; reason: string; }>
  | Readonly<{ status: 'superseded'; generation: number; target: SupportedLocale; }>;

export type LocaleDomainBundlePort = Readonly<{
    prepareLocaleDomains: (
        locale: SupportedLocale,
        domains: readonly LocaleDomain[],
        signal?: AbortSignal
    ) => Promise<PreparedLocaleDomains>;
}>;

export type LocaleFontPreparationPort = Readonly<{
    prepareLocaleFonts: (
        locale: SupportedLocale,
        weights: readonly LocaleFontWeight[],
        signal?: AbortSignal
    ) => Promise<LocaleFontPreparationReceipt>;
}>;

export type LocalePreferenceCommitPort = Readonly<{
    commit: (
        command: LocalePreferenceCommitCommand,
        signal?: AbortSignal
    ) => Promise<LocalePreferenceCommitReceipt>;
}>;

export type LocaleMetadataPort = Readonly<{
    commitDocumentMetadata: (locale: SupportedLocale) => void;
}>;

export type LocaleRuntimeClockPort = Readonly<{
    now: () => number;
}>;

export type LocaleRuntimeTelemetryPort = Readonly<{
    phase: (
        from: string,
        to: string,
        state: LocaleRuntimeState,
        durationMs: number
    ) => void;
    failed: (state: LocaleRuntimeFailed) => void;
    committed: (active: LocaleRuntimeActive) => void;
}>;

export type LocaleRuntimePorts = Readonly<{
    domainBundlePort: LocaleDomainBundlePort;
    fontPreparationPort: LocaleFontPreparationPort;
    preferenceCommitPort: LocalePreferenceCommitPort;
    metadataPort: LocaleMetadataPort;
    clock: LocaleRuntimeClockPort;
    telemetryPort: LocaleRuntimeTelemetryPort;
    onStateChange?: (state: LocaleRuntimeState) => void;
    fontWeights?: readonly LocaleFontWeight[];
}>;

export type LocaleRouteTransaction = Readonly<{
    snapshot: PreparedLocaleDomains;
    commit: () => void;
    rollback: () => void;
}>;

type PreparationKey = string;

interface InFlightPreparation {
    key: PreparationKey;
    target: SupportedLocale;
    domains: readonly LocaleDomain[];
    promise: Promise<{
        domains: PreparedLocaleDomains;
        fonts: LocaleFontPreparationReceipt;
    }>;
    controller: AbortController;
    subscribers: number;
}

function abortError(): DOMException
{
    return new DOMException('Locale transaction aborted', 'AbortError');
}

function isAbortLike(error: unknown): boolean
{
    return (error as { name?: string; } | null)?.name === 'AbortError';
}

function failureReason(error: unknown): string
{
    if (error instanceof Error && error.message)
    {
        return error.message;
    }
    return String(error);
}

function normalizeDomains(domains: readonly LocaleDomain[]): readonly LocaleDomain[]
{
    return Object.freeze([...new Set(domains)]);
}

function preparationKey(
    target: SupportedLocale,
    domains: readonly LocaleDomain[]
): PreparationKey
{
    return `${target}\u0000${[...domains].sort().join('\u0001')}`;
}

function freezeState(state: LocaleRuntimeState): LocaleRuntimeState
{
    return Object.freeze({
        active: state.active
            ? Object.freeze({
          ...state.active,
          loadedDomains: Object.freeze([...state.active.loadedDomains]),
          messages: state.active.messages
        })
            : null,
        preparing: state.preparing
            ? Object.freeze({
          ...state.preparing,
          requiredDomains: Object.freeze([...state.preparing.requiredDomains])
        })
            : null,
        committing: state.committing ? Object.freeze({ ...state.committing }) : null,
        failed: state.failed ? Object.freeze({ ...state.failed }) : null
    });
}

/**
 * Pure locale runtime authority. Depends only on injected ports; never imports
 * Vue, Router, Pinia, Cookie APIs, browser storage, or concrete font/backend clients.
 */
export class LocaleRuntimeCoordinator
{
    private readonly ports: LocaleRuntimePorts;
    private readonly fontWeights: readonly LocaleFontWeight[];
    private state: LocaleRuntimeState = freezeState({
        active: null,
        preparing: null,
        committing: null,
        failed: null
    });
    private generation = 0;
    private phaseStartedAt: number;
    private preparationController: AbortController | null = null;
    private inFlightPreparation: InFlightPreparation | null = null;
    private preferenceCommitTail: Promise<void> = Promise.resolve();
    private commitMutex: Promise<void> = Promise.resolve();
    private terminalGenerations = new Set<number>();

    constructor(ports: LocaleRuntimePorts)
    {
        this.ports = ports;
        this.fontWeights = Object.freeze(
      ports.fontWeights && ports.fontWeights.length > 0
          ? [...ports.fontWeights]
          : ([400, 500] as LocaleFontWeight[])
        );
        this.phaseStartedAt = ports.clock.now();
        ports.onStateChange?.(this.state);
    }

    snapshot(): LocaleRuntimeState
    {
        return this.state;
    }

    /**
   * First client authority commit for a server-resolved locale. Does not
   * re-decide locale and does not persist preference. Missing critical domains
   * fail closed without publishing a default fallback.
   */
    async activateInitial(
        locale: SupportedLocale,
        requiredDomains: readonly LocaleDomain[]
    ): Promise<LocaleRuntimeOutcome>
    {
        return this.runTransaction({
            target: locale,
            requiredDomains,
            preference: null,
            kind: 'initial'
        });
    }

    /**
   * Explicit locale selection transaction:
   * prepare domains+fonts in parallel → optional preference commit → atomic UI.
   */
    async requestLocale(
        target: SupportedLocale,
        requiredDomains?: readonly LocaleDomain[],
        options?: Readonly<{ persistPreference?: boolean; }>
    ): Promise<LocaleRuntimeOutcome>
    {
        const explicitDomains = requiredDomains
            ? normalizeDomains(requiredDomains)
            : null;
        const fallbackDomains = this.state.active?.loadedDomains
      ?? Object.freeze([] as LocaleDomain[]);
        if ((explicitDomains?.length ?? fallbackDomains.length) === 0)
        {
            return this.failOutcome(
                ++this.generation,
                target,
                'locale_runtime_domains_required'
            );
        }
        const persistPreference = options?.persistPreference === true;
        return this.runTransaction({
            target,
            requiredDomains: explicitDomains ?? fallbackDomains,
            resolveDomainsFromActive: explicitDomains === null,
            preference: persistPreference
                ? Object.freeze({ mode: 'fixed', locale: target })
                : null,
            kind: 'request'
        });
    }

    /**
   * Preference-driven path. Auto resolves an effective locale from the
   * preference commit port, then reuses the same prepare/commit path.
   */
    async requestLocalePreference(
        command: LocalePreferenceCommitCommand,
        requiredDomains?: readonly LocaleDomain[]
    ): Promise<LocaleRuntimeOutcome>
    {
        const domains = requiredDomains
      ?? this.state.active?.loadedDomains
      ?? Object.freeze([] as LocaleDomain[]);
        if (domains.length === 0)
        {
            const target = command.mode === 'fixed' ? command.locale : DEFAULT_LOCALE;
            return this.failOutcome(
                ++this.generation,
                target,
                'locale_runtime_domains_required'
            );
        }

        if (command.mode === 'auto')
        {
            const generation = ++this.generation;
            this.abortPreparation();
            const failureTarget = this.state.active?.locale ?? DEFAULT_LOCALE;

            let effectiveLocale: SupportedLocale;
            try
            {
                // Preference commit for auto starts first so the command can return the
                // effective locale; remote preference work is never cancelled mid-flight.
                const receipt = await this.enqueuePreferenceCommit(command);
                if (generation !== this.generation)
                {
                    return Object.freeze({
                        status: 'superseded',
                        generation,
                        target: receipt.effectiveLocale
                    });
                }
                effectiveLocale = receipt.effectiveLocale;
            }
            catch (error)
            {
                if (generation !== this.generation)
                {
                    return Object.freeze({
                        status: 'superseded',
                        generation,
                        target: failureTarget
                    });
                }
                return this.markFailed(generation, failureTarget, failureReason(error));
            }

            return this.runTransaction({
                target: effectiveLocale,
                requiredDomains: domains,
                preference: null,
                kind: 'preference-auto',
                generation
            });
        }

        return this.runTransaction({
            target: command.locale,
            requiredDomains: domains,
            preference: command,
            kind: 'preference-fixed'
        });
    }

    /**
   * Stages route domain expansion for the active locale. Router owns final
   * commit/rollback so redirects cannot publish candidate domains.
   */
    async beginRouteTransaction(
        domains: readonly LocaleDomain[],
        signal?: AbortSignal
    ): Promise<LocaleRouteTransaction>
    {
        const release = await this.acquireCommitMutex(signal);
        try
        {
            const active = this.state.active;
            if (!active)
            {
                throw new Error('locale_runtime_uninitialized');
            }
            const snapshot = await this.ports.domainBundlePort.prepareLocaleDomains(
                active.locale,
                normalizeDomains(domains),
                signal
            );
            if (signal?.aborted)
            {
                throw abortError();
            }
            if (this.state.active?.generation !== active.generation
        || this.state.active.locale !== active.locale)
            {
                throw new Error(
                    `i18n_route_snapshot_locale_stale:${snapshot.locale}:${this.state.active?.locale ?? 'none'}`
                );
            }

            let settled = false;
            const settle = (commit: boolean): void =>
            {
                if (settled)
                {
                    return;
                }
                settled = true;
                try
                {
                    if (commit)
                    {
                        if (this.state.active?.generation !== active.generation
              || this.state.active.locale !== snapshot.locale)
                        {
                            throw new Error(
                                `i18n_route_snapshot_locale_stale:${snapshot.locale}:${this.state.active?.locale ?? 'none'}`
                            );
                        }
                        this.publishActive({
                            locale: snapshot.locale,
                            loadedDomains: snapshot.domains,
                            generation: active.generation,
                            messages: snapshot.messages
                        }, { metadata: false });
                    }
                }
                finally
                {
                    release();
                }
            };

            return Object.freeze({
                snapshot,
                commit: () => settle(true),
                rollback: () => settle(false)
            });
        }
        catch (error)
        {
            release();
            throw error;
        }
    }

    resetForTests(): void
    {
        this.abortPreparation();
        this.generation = 0;
        this.terminalGenerations.clear();
        this.inFlightPreparation = null;
        this.preferenceCommitTail = Promise.resolve();
        this.commitMutex = Promise.resolve();
        this.replaceState({
            active: null,
            preparing: null,
            committing: null,
            failed: null
        }, 'reset');
    }

    private async runTransaction(input: Readonly<{
        target: SupportedLocale;
        requiredDomains: readonly LocaleDomain[];
        preference: LocalePreferenceCommitCommand | null;
        kind: 'initial' | 'request' | 'preference-fixed' | 'preference-auto';
        generation?: number;
        resolveDomainsFromActive?: boolean;
    }>): Promise<LocaleRuntimeOutcome>
    {
        let domains = normalizeDomains(input.requiredDomains);
        const active = this.state.active;
        if (
            input.kind !== 'initial'
      && active
      && active.locale === input.target
      && domains.every((domain) => active.loadedDomains.includes(domain))
      && active.loadedDomains.length === domains.length
      && input.preference === null
        )
        {
            return Object.freeze({
                status: 'active',
                generation: active.generation,
                locale: active.locale
            });
        }

        const reuseKey = preparationKey(input.target, domains);
        const canReusePreparation = Boolean(
            this.inFlightPreparation
      && this.inFlightPreparation.key === reuseKey
      && !this.inFlightPreparation.controller.signal.aborted
        );
        const generation = input.generation ?? ++this.generation;
        // Same target/domains join the in-flight producer; only a different target
        // aborts preparation. Preference commits are never aborted here.
        if (input.generation === undefined && !canReusePreparation)
        {
            this.abortPreparation();
        }

        this.publishPreparing(input.target, domains, generation);

        let prepared: {
            domains: PreparedLocaleDomains;
            fonts: LocaleFontPreparationReceipt;
        };
        try
        {
            prepared = await this.prepareResources(input.target, domains, generation);
        }
        catch (error)
        {
            if (generation !== this.generation || isAbortLike(error))
            {
                return this.supersededOrActive(generation, input.target, domains);
            }
            return this.markFailed(generation, input.target, failureReason(error));
        }

        if (generation !== this.generation)
        {
            return this.supersededOrActive(generation, input.target, domains);
        }

        const release = await this.acquireCommitMutex();
        try
        {
            if (generation !== this.generation)
            {
                return this.supersededOrActive(generation, input.target, domains);
            }

            if (input.resolveDomainsFromActive && this.state.active)
            {
                const latestDomains = normalizeDomains(this.state.active.loadedDomains);
                if (preparationKey(input.target, latestDomains) !== preparationKey(input.target, domains))
                {
                    domains = latestDomains;
                    this.publishPreparing(input.target, domains, generation);
                    prepared = await this.prepareResources(input.target, domains, generation);
                }
            }

            this.publishCommitting(input.target, generation);

            if (input.preference)
            {
                try
                {
                    await this.enqueuePreferenceCommit(input.preference);
                }
                catch (error)
                {
                    if (generation !== this.generation)
                    {
                        return this.supersededOrActive(generation, input.target, domains);
                    }
                    return this.markFailed(generation, input.target, failureReason(error));
                }
            }

            if (generation !== this.generation)
            {
                return this.supersededOrActive(generation, input.target, domains);
            }

            if (this.terminalGenerations.has(generation))
            {
                return this.supersededOrActive(generation, input.target, domains);
            }

            const nextActive = Object.freeze({
                locale: prepared.domains.locale,
                loadedDomains: prepared.domains.domains,
                generation,
                messages: prepared.domains.messages
            });
            this.terminalGenerations.add(generation);
            this.publishActive(nextActive, { metadata: true });
            this.ports.telemetryPort.committed(nextActive);
            return Object.freeze({
                status: 'active',
                generation,
                locale: nextActive.locale
            });
        }
        finally
        {
            release();
        }
    }

    private supersededOrActive(
        generation: number,
        target: SupportedLocale,
        domains: readonly LocaleDomain[]
    ): LocaleRuntimeOutcome
    {
        const current = this.state.active;
        if (
            current
      && current.locale === target
      && domains.every((domain) => current.loadedDomains.includes(domain))
        )
        {
            return Object.freeze({
                status: 'active',
                generation: current.generation,
                locale: current.locale
            });
        }
        return Object.freeze({
            status: 'superseded',
            generation,
            target
        });
    }

    private async joinPreparation(
        flight: InFlightPreparation
    ): Promise<{
        domains: PreparedLocaleDomains;
        fonts: LocaleFontPreparationReceipt;
    }>
    {
        flight.subscribers += 1;
        try
        {
            return await flight.promise;
        }
        finally
        {
            flight.subscribers -= 1;
            if (flight.subscribers <= 0 && this.inFlightPreparation === flight)
            {
                this.inFlightPreparation = null;
            }
        }
    }

    private async prepareResources(
        target: SupportedLocale,
        domains: readonly LocaleDomain[],
        _generation: number
    ): Promise<{
        domains: PreparedLocaleDomains;
        fonts: LocaleFontPreparationReceipt;
    }>
    {
        const key = preparationKey(target, domains);
        const existing = this.inFlightPreparation;
        if (
            existing
      && existing.key === key
      && !existing.controller.signal.aborted
        )
        {
            return this.joinPreparation(existing);
        }

        // Abort only a different target/domain preparation. Same-key joiners share
        // this producer; generation freshness is checked by each waiter after await.
        if (existing && existing.key !== key)
        {
            this.abortPreparation();
        }

        const raced = this.inFlightPreparation;
        if (
            raced
      && raced.key === key
      && !raced.controller.signal.aborted
        )
        {
            return this.joinPreparation(raced);
        }

        const controller = new AbortController();
        this.preparationController = controller;
        const promise = (async () =>
        {
            const [domainSnapshot, fontReceipt] = await Promise.all([
                this.ports.domainBundlePort.prepareLocaleDomains(
                    target,
                    domains,
                    controller.signal
                ),
                this.ports.fontPreparationPort.prepareLocaleFonts(
                    target,
                    this.fontWeights,
                    controller.signal
                )
            ]);
            if (controller.signal.aborted)
            {
                throw abortError();
            }
            return Object.freeze({
                domains: domainSnapshot,
                fonts: fontReceipt
            });
        })();

        const flight: InFlightPreparation = {
            key,
            target,
            domains,
            promise,
            controller,
            subscribers: 1
        };
        this.inFlightPreparation = flight;
        try
        {
            return await promise;
        }
        finally
        {
            flight.subscribers -= 1;
            if (flight.subscribers <= 0 && this.inFlightPreparation === flight)
            {
                this.inFlightPreparation = null;
            }
            if (this.preparationController === controller)
            {
                this.preparationController = null;
            }
        }
    }

    private enqueuePreferenceCommit(
        command: LocalePreferenceCommitCommand
    ): Promise<LocalePreferenceCommitReceipt>
    {
        const run = this.preferenceCommitTail.then(
            () => this.ports.preferenceCommitPort.commit(command),
            () => this.ports.preferenceCommitPort.commit(command)
        );
        this.preferenceCommitTail = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private async acquireCommitMutex(signal?: AbortSignal): Promise<() => void>
    {
        let releaseCurrent!: () => void;
        const current = new Promise<void>((resolve) =>
        {
            releaseCurrent = resolve;
        });
        const previous = this.commitMutex;
        this.commitMutex = previous.then(() => current);
        await previous;
        if (signal?.aborted)
        {
            releaseCurrent();
            throw abortError();
        }
        let released = false;
        return () =>
        {
            if (released)
            {
                return;
            }
            released = true;
            releaseCurrent();
        };
    }

    private abortPreparation(): void
    {
        if (this.preparationController && !this.preparationController.signal.aborted)
        {
            this.preparationController.abort();
        }
        this.preparationController = null;
        if (this.inFlightPreparation)
        {
            if (!this.inFlightPreparation.controller.signal.aborted)
            {
                this.inFlightPreparation.controller.abort();
            }
            this.inFlightPreparation = null;
        }
    }

    private publishPreparing(
        target: SupportedLocale,
        requiredDomains: readonly LocaleDomain[],
        generation: number
    ): void
    {
        this.replaceState({
            active: this.state.active,
            preparing: Object.freeze({
                target,
                requiredDomains,
                generation
            }),
            committing: null,
            failed: null
        }, 'preparing');
    }

    private publishCommitting(target: SupportedLocale, generation: number): void
    {
        this.replaceState({
            active: this.state.active,
            preparing: null,
            committing: Object.freeze({ target, generation }),
            failed: null
        }, 'committing');
    }

    private publishActive(
        active: LocaleRuntimeActive,
        options: Readonly<{ metadata: boolean; }>
    ): void
    {
        if (options.metadata)
        {
            this.ports.metadataPort.commitDocumentMetadata(active.locale);
        }
        this.replaceState({
            active,
            preparing: null,
            committing: null,
            failed: null
        }, 'active');
    }

    private markFailed(
        generation: number,
        target: SupportedLocale,
        reason: string
    ): LocaleRuntimeOutcome
    {
        if (this.terminalGenerations.has(generation))
        {
            return Object.freeze({
                status: 'superseded',
                generation,
                target
            });
        }
        this.terminalGenerations.add(generation);
        const failed = Object.freeze({ target, generation, reason });
        this.replaceState({
            active: this.state.active,
            preparing: null,
            committing: null,
            failed
        }, 'failed');
        this.ports.telemetryPort.failed(failed);
        return this.failOutcome(generation, target, reason);
    }

    private failOutcome(
        generation: number,
        target: SupportedLocale,
        reason: string
    ): LocaleRuntimeOutcome
    {
        return Object.freeze({
            status: 'failed',
            generation,
            target,
            reason
        });
    }

    private replaceState(next: LocaleRuntimeState, phase: string): void
    {
        const previousPhase = this.state.committing
            ? 'committing'
            : this.state.preparing
        ? 'preparing'
        : this.state.failed
          ? 'failed'
          : this.state.active
            ? 'active'
            : 'uninitialized';
        const now = this.ports.clock.now();
        this.state = freezeState(next);
        this.ports.telemetryPort.phase(
            previousPhase,
            phase,
            this.state,
            Math.max(0, now - this.phaseStartedAt)
        );
        this.phaseStartedAt = now;
        this.ports.onStateChange?.(this.state);
    }
}
