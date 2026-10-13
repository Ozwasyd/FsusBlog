export type PublicActivationPhase =
  | 'static-visible'
  | 'silent-warming'
  | 'foreground-wait'
  | 'prepared'
  | 'committing'
  | 'interactive'
  | 'fallback';

export type PublicActivationOwner = 'aot' | 'full-app' | 'document-navigation';
export type PublicActivationIntentKind = 'activate' | 'navigate';

export type PublicActivationIntent = Readonly<{
    target: string;
    source: string;
    kind: PublicActivationIntentKind;
}>;

export type PublicBootActivationIntent = Readonly<{
    type: string;
    timestamp: number;
}>;

export type PublicActivationState = Readonly<{
    generation: number;
    intent: PublicActivationIntent | null;
    phase: PublicActivationPhase;
    owner: PublicActivationOwner;
    foregroundFeedbackVisible: boolean;
    failureReason: string | null;
    replaceable: boolean;
}>;

export type PublicRoutePreparationResult = Readonly<{
    ready: boolean;
    reason?: string;
    routeComponentMs?: number;
    routeSnapshotMs?: number;
}>;

export type PublicCoreWarmResult = Readonly<{
    ready: boolean;
    reason?: string;
}>;

export type PublicActivationPrepareTiming = Readonly<{
    generation: number;
    target: string;
    source: string;
    core_prepare_ms: number;
    route_component_ms: number | null;
    route_snapshot_ms: number | null;
    activation_prepare_wall_ms: number;
}>;

export type PublicActivationOutcome =
  | Readonly<{ generation: number; status: 'interactive'; }>
  | Readonly<{ generation: number; status: 'fallback'; reason: string; }>
  | Readonly<{ generation: number; status: 'queued'; }>
  | Readonly<{ generation: number; status: 'rejected'; reason: string; }>;

/**
 * Injected ports for PublicActivationCoordinator.
 *
 * - `routePreparationPort` prepares a target route component/snapshot/SEO seed only.
 * - `fullAppPort.warm/prepare` load and construct FullApp core only; they never
 *   request a public route navigation snapshot.
 * Core warming and intent route preparation are independent concepts.
 */
export type PublicActivationPorts<PreparedApp = unknown> = Readonly<{
    routePreparationPort: {
        prepare: (intent: PublicActivationIntent, signal: AbortSignal) => Promise<PublicRoutePreparationResult>;
    };
    fullAppPort: {
    /** Idle/core-only warm: load SPA entry modules. Must not accept a route URL. */
        warm: () => Promise<void>;
        /** Construct FullApp core/router/plugins without mounting or fetching route snapshots. */
        prepare: (intent: PublicActivationIntent) => Promise<PreparedApp>;
        commit: (prepared: PreparedApp, intent: PublicActivationIntent) => Promise<void>;
        navigate: (intent: PublicActivationIntent) => Promise<void>;
    };
    feedbackPort: {
    /** Immediate wait ownership for assistive tech; visual loader waits for one frame. */
        markBusy: (intent: PublicActivationIntent) => void;
        show: (intent: PublicActivationIntent) => void;
        hide: () => void;
    };
    fallbackPort: {
        navigate: (intent: PublicActivationIntent, reason: string) => void;
    };
    telemetryPort: {
        phase: (
            from: PublicActivationPhase,
            to: PublicActivationPhase,
            state: PublicActivationState,
            durationMs: number
        ) => void;
        illegalTransition: (from: PublicActivationPhase, to: PublicActivationPhase, reason: string) => void;
        terminal: (outcome: Extract<PublicActivationOutcome, { status: 'interactive' | 'fallback'; }>) => void;
        prepareTiming?: (timing: PublicActivationPrepareTiming) => void;
    };
    clock: {
        now: () => number;
        queueMicrotask: (callback: () => void) => void;
        setTimer: (callback: () => void, delayMs: number) => number;
        clearTimer: (handle: number) => void;
        requestFrame: (callback: () => void) => number;
        cancelFrame: (handle: number) => void;
    };
    onStateChange?: (state: PublicActivationState) => void;
}>;

interface PublicWarmOwnership {
    adoptedByActivation: boolean;
}

const legalTransitions: Record<PublicActivationPhase, readonly PublicActivationPhase[]> = {
    'static-visible': ['silent-warming', 'foreground-wait', 'fallback'],
    'silent-warming': ['static-visible', 'silent-warming', 'foreground-wait', 'prepared', 'fallback'],
    'foreground-wait': ['foreground-wait', 'prepared', 'fallback'],
    prepared: ['silent-warming', 'foreground-wait', 'committing', 'fallback'],
    committing: ['interactive', 'fallback'],
    interactive: ['interactive'],
    fallback: ['fallback']
};

function ownerForPhase(phase: PublicActivationPhase): PublicActivationOwner
{
    if (phase === 'committing' || phase === 'interactive')
    {
        return 'full-app';
    }
    return phase === 'fallback' ? 'document-navigation' : 'aot';
}

function normalizeIntent(intent: PublicActivationIntent): PublicActivationIntent
{
    return {
        target: intent.target.trim() || '/',
        source: intent.source.trim() || 'unknown',
        kind: intent.kind
    };
}

export function createPublicBootActivationIntent(
    intent: PublicBootActivationIntent,
    target: string
): PublicActivationIntent
{
    return normalizeIntent({
        kind: 'activate',
        source: `boot-${intent.type}`,
        target
    });
}

function failureReason(error: unknown): string
{
    return error instanceof Error ? error.message : String(error);
}

function isAbortLike(error: unknown): boolean
{
    return (error as { name?: string; } | null)?.name === 'AbortError';
}

function preferProducerFailure(errors: readonly unknown[]): unknown
{
    const nonAbort = errors.find((error) => error !== undefined && !isAbortLike(error));
    return nonAbort ?? errors.find((error) => error !== undefined) ?? new Error('activation-prepare-failed');
}

export function canTransitionPublicActivation(
    from: PublicActivationPhase,
    to: PublicActivationPhase
): boolean
{
    return legalTransitions[from].includes(to);
}

export class PublicActivationCoordinator<PreparedApp = unknown>
{
    private readonly ports: PublicActivationPorts<PreparedApp>;
    private state: PublicActivationState = {
        generation: 0,
        intent: null,
        phase: 'static-visible',
        owner: 'aot',
        foregroundFeedbackVisible: false,
        failureReason: null,
        replaceable: true
    };

    private phaseStartedAt: number;
    private preparationController: AbortController | null = null;
    private activationPromise: Promise<PublicActivationOutcome> | null = null;
    private warmingPromise: Promise<PublicRoutePreparationResult> | null = null;
    private warmingOwnership: PublicWarmOwnership | null = null;
    private warmedTarget: string | null = null;
    private warmedResult: PublicRoutePreparationResult | null = null;
    private feedbackFrame: number | null = null;
    private feedbackBusy = false;
    private queuedIntent: PublicActivationIntent | null = null;
    private terminalGenerations = new Set<number>();

    constructor(ports: PublicActivationPorts<PreparedApp>)
    {
        this.ports = ports;
        this.phaseStartedAt = ports.clock.now();
        ports.onStateChange?.(this.state);
    }

    snapshot(): PublicActivationState
    {
        return this.state;
    }

    transition(to: PublicActivationPhase, reason: string): boolean
    {
        const from = this.state.phase;
        if (!canTransitionPublicActivation(from, to))
        {
            this.ports.telemetryPort.illegalTransition(from, to, reason);
            return false;
        }

        const now = this.ports.clock.now();
        this.state = {
            ...this.state,
            phase: to,
            owner: ownerForPhase(to),
            replaceable: to !== 'committing' && to !== 'interactive' && to !== 'fallback'
        };
        this.ports.telemetryPort.phase(from, to, this.state, Math.max(0, now - this.phaseStartedAt));
        this.phaseStartedAt = now;
        this.ports.onStateChange?.(this.state);
        return true;
    }

    /**
   * Idle FullApp core warming only.
   * Must not accept a route URL, request navigation snapshots, or create route seeds.
   */
    warmCore(source?: string): Promise<PublicCoreWarmResult>;
    async warmCore(): Promise<PublicCoreWarmResult>
    {
        if (this.activationPromise)
        {
            return { ready: false, reason: 'activation-in-progress' };
        }
        if (this.state.phase === 'interactive' || this.state.phase === 'committing' || this.state.phase === 'fallback')
        {
            return { ready: false, reason: 'activation-not-replaceable' };
        }
        try
        {
            await this.ports.fullAppPort.warm();
            return { ready: true };
        }
        catch (error)
        {
            return { ready: false, reason: failureReason(error) };
        }
    }

    /**
   * Intent-targeted route preparation (pointerenter/focus).
   * Prepares component/snapshot/SEO seed only; never commits FullApp.
   */
    async warm(target: string, source = 'pointerenter'): Promise<PublicRoutePreparationResult>
    {
        const normalized = normalizeIntent({ target, source, kind: 'activate' });
        if (this.activationPromise)
        {
            return { ready: false, reason: 'activation-in-progress' };
        }
        if (this.state.phase === 'interactive' || this.state.phase === 'committing' || this.state.phase === 'fallback')
        {
            return { ready: false, reason: 'activation-not-replaceable' };
        }
        if (this.warmedTarget === normalized.target && this.warmingPromise)
        {
            return await this.warmingPromise;
        }

        this.preparationController?.abort();
        const controller = new AbortController();
        const ownership: PublicWarmOwnership = { adoptedByActivation: false };
        this.preparationController = controller;
        this.warmingOwnership = ownership;
        this.warmedTarget = normalized.target;
        this.warmedResult = null;
        this.state = {
            ...this.state,
            intent: normalized,
            failureReason: null
        };
        this.transition('silent-warming', 'warm-started');
        const promise = this.ports.routePreparationPort.prepare(normalized, controller.signal)
            .then((result) =>
            {
                if (controller.signal.aborted || this.preparationController !== controller)
                {
                    return { ready: false, reason: 'replaced' };
                }
                if (result.ready)
                {
                    this.warmedResult = result;
                    if (!ownership.adoptedByActivation)
                    {
                        this.transition('prepared', 'warm-ready');
                    }
                }
                else
                {
                    this.warmedTarget = null;
                    this.warmedResult = null;
                    if (!ownership.adoptedByActivation)
                    {
                        this.state = { ...this.state, intent: null };
                        this.transition('static-visible', result.reason ?? 'warm-not-ready');
                    }
                }
                return result;
            })
            .catch((error: unknown) =>
            {
                if (controller.signal.aborted || this.preparationController !== controller)
                {
                    return { ready: false, reason: 'replaced' };
                }
                this.warmedTarget = null;
                this.warmedResult = null;
                if (!ownership.adoptedByActivation)
                {
                    this.state = { ...this.state, intent: null };
                    this.transition('static-visible', failureReason(error));
                }
                return { ready: false, reason: failureReason(error) };
            })
            .finally(() =>
            {
                if (this.preparationController === controller && !ownership.adoptedByActivation)
                {
                    this.preparationController = null;
                }
                if (this.warmingOwnership === ownership && !ownership.adoptedByActivation)
                {
                    this.warmingOwnership = null;
                }
                if (this.warmingPromise === promise && this.warmedTarget === null)
                {
                    this.warmingPromise = null;
                }
            });
        this.warmingPromise = promise;
        return await promise;
    }

    submitIntent(input: PublicActivationIntent): Promise<PublicActivationOutcome>
    {
        const intent = normalizeIntent(input);
        if (this.state.phase === 'fallback')
        {
            return Promise.resolve({
                generation: this.state.generation,
                status: 'rejected',
                reason: 'fallback-already-started'
            });
        }
        if (this.state.phase === 'interactive')
        {
            return this.navigateInteractive(intent);
        }
        if (this.state.phase === 'committing')
        {
            this.queuedIntent = intent;
            return Promise.resolve({ generation: this.state.generation, status: 'queued' });
        }
        if (this.state.intent?.target === intent.target && this.activationPromise)
        {
            return this.activationPromise;
        }

        const canReuseWarm = this.warmedTarget === intent.target
      && (this.warmedResult?.ready === true || this.warmingPromise !== null);
        const reusableWarmingPromise = canReuseWarm ? this.warmingPromise : null;
        if (reusableWarmingPromise && this.warmingOwnership)
        {
            this.warmingOwnership.adoptedByActivation = true;
        }
        if (!canReuseWarm)
        {
            this.preparationController?.abort();
        }
        if (!canReuseWarm)
        {
            this.warmedTarget = null;
            this.warmedResult = null;
            this.warmingPromise = null;
        }
        this.clearFeedback();
        const generation = this.state.generation + 1;
        const controller = canReuseWarm && this.preparationController
            ? this.preparationController
            : new AbortController();
        this.preparationController = controller;
        this.state = {
            ...this.state,
            generation,
            intent,
            failureReason: null,
            foregroundFeedbackVisible: false,
            replaceable: true
        };
        this.ports.onStateChange?.(this.state);
        this.transition('foreground-wait', 'intent-submitted');
        this.scheduleForegroundFeedback(generation, intent);

        const promise = this.runActivation(generation, intent, controller, reusableWarmingPromise)
            .finally(() =>
            {
                if (this.activationPromise === promise)
                {
                    this.activationPromise = null;
                }
            });
        this.activationPromise = promise;
        return promise;
    }

    private async runActivation(
        generation: number,
        intent: PublicActivationIntent,
        controller: AbortController,
        reusableWarmingPromise: Promise<PublicRoutePreparationResult> | null
    ): Promise<PublicActivationOutcome>
    {
        await new Promise<void>((resolve) => this.ports.clock.queueMicrotask(resolve));
        const prepareWallStartedAt = this.ports.clock.now();
        let corePrepareMs = 0;
        try
        {
            // FullApp core prepare and target route preparation start in the same generation
            // before either producer resolves. Commit only when both succeed for this generation.
            const routeTask = (async (): Promise<PublicRoutePreparationResult> =>
            {
                try
                {
                    if (this.warmedTarget === intent.target && this.warmedResult?.ready === true)
                    {
                        return this.warmedResult;
                    }
                    if (reusableWarmingPromise)
                    {
                        return await reusableWarmingPromise;
                    }
                    this.warmedTarget = intent.target;
                    return await this.ports.routePreparationPort.prepare(intent, controller.signal);
                }
                catch (error)
                {
                    if (!controller.signal.aborted)
                    {
                        controller.abort(error);
                    }
                    throw error;
                }
            })();

            const coreTask = (async (): Promise<PreparedApp> =>
            {
                const startedAt = this.ports.clock.now();
                try
                {
                    const prepared = await this.ports.fullAppPort.prepare(intent);
                    corePrepareMs = Math.max(0, this.ports.clock.now() - startedAt);
                    return prepared;
                }
                catch (error)
                {
                    corePrepareMs = Math.max(0, this.ports.clock.now() - startedAt);
                    if (!controller.signal.aborted)
                    {
                        controller.abort(error);
                    }
                    throw error;
                }
            })();

            const settled = await Promise.allSettled([routeTask, coreTask]);
            const routeSettled = settled[0];
            const coreSettled = settled[1];
            if (routeSettled.status === 'rejected' || coreSettled.status === 'rejected')
            {
                this.emitPrepareTiming(generation, intent, prepareWallStartedAt, corePrepareMs,
                    routeSettled.status === 'fulfilled' ? routeSettled.value : null);
                throw preferProducerFailure([
          coreSettled.status === 'rejected' ? coreSettled.reason : undefined,
          routeSettled.status === 'rejected' ? routeSettled.reason : undefined
                ]);
            }
            const prepared = coreSettled.value;
            const routeResult = routeSettled.value;

            const wallMs = Math.max(0, this.ports.clock.now() - prepareWallStartedAt);
            this.emitPrepareTiming(generation, intent, prepareWallStartedAt, corePrepareMs, routeResult, wallMs);

            if (!this.isCurrent(generation, controller))
            {
                return this.replaced(generation);
            }
            if (!routeResult.ready)
            {
                return this.fallback(
                    generation,
                    intent,
                    routeResult.reason ?? 'route-preparation-not-ready'
                );
            }

            if (this.state.phase !== 'prepared')
            {
                this.transition('prepared', 'core-and-route-prepared');
            }

            this.preparationController = null;
            this.transition('committing', 'full-app-prepared');
            await this.ports.fullAppPort.commit(prepared, intent);
            this.transition('interactive', 'full-app-committed');
            this.clearFeedback();
            const outcome = { generation, status: 'interactive' } as const;
            this.recordTerminal(outcome);

            const queued = this.queuedIntent;
            this.queuedIntent = null;
            if (queued)
            {
                await this.navigateInteractive(queued);
            }
            return outcome;
        }
        catch (error)
        {
            // A newer intent increments generation before aborting this controller.
            // Self-abort of a sibling producer for the current generation must fall
            // back with the producer failure reason, not "replaced".
            if (!this.isCurrentGeneration(generation))
            {
                return this.replaced(generation);
            }
            if (
                this.state.phase !== 'committing' &&
        this.preparationController !== null &&
        this.preparationController !== controller
            )
            {
                return this.replaced(generation);
            }
            return this.fallback(generation, intent, failureReason(error));
        }
    }

    private emitPrepareTiming(
        generation: number,
        intent: PublicActivationIntent,
        prepareWallStartedAt: number,
        corePrepareMs: number,
        routeResult: PublicRoutePreparationResult | null,
        wallMs = Math.max(0, this.ports.clock.now() - prepareWallStartedAt)
    ): void
    {
        this.ports.telemetryPort.prepareTiming?.({
            generation,
            target: intent.target,
            source: intent.source,
            core_prepare_ms: corePrepareMs,
            route_component_ms: routeResult?.routeComponentMs ?? null,
            route_snapshot_ms: routeResult?.routeSnapshotMs ?? null,
            // Wall time is the parallel barrier duration, not the sum of producer times.
            activation_prepare_wall_ms: wallMs
        });
    }

    private async navigateInteractive(intent: PublicActivationIntent): Promise<PublicActivationOutcome>
    {
        try
        {
            await this.ports.fullAppPort.navigate(intent);
            return { generation: this.state.generation, status: 'interactive' };
        }
        catch (error)
        {
            this.ports.telemetryPort.illegalTransition('interactive', 'fallback', failureReason(error));
            return {
                generation: this.state.generation,
                status: 'rejected',
                reason: 'interactive-navigation-failed'
            };
        }
    }

    private fallback(
        generation: number,
        intent: PublicActivationIntent,
        reason: string
    ): Extract<PublicActivationOutcome, { status: 'fallback'; }>
    {
        if (!this.isCurrentGeneration(generation) || this.terminalGenerations.has(generation))
        {
            return { generation, status: 'fallback', reason };
        }

        this.clearFeedback();
        this.state = { ...this.state, failureReason: reason };
        this.ports.onStateChange?.(this.state);
        this.transition('fallback', reason);
        const outcome = { generation, status: 'fallback', reason } as const;
        this.recordTerminal(outcome);
        this.ports.fallbackPort.navigate(intent, reason);
        return outcome;
    }

    private replaced(
        generation: number
    ): Extract<PublicActivationOutcome, { status: 'fallback'; }>
    {
        const outcome = {
            generation,
            status: 'fallback',
            reason: 'replaced-by-newer-intent'
        } as const;
        this.recordTerminal(outcome);
        return outcome;
    }

    private recordTerminal(
        outcome: Extract<PublicActivationOutcome, { status: 'interactive' | 'fallback'; }>
    ): void
    {
        if (this.terminalGenerations.has(outcome.generation))
        {
            return;
        }
        this.terminalGenerations.add(outcome.generation);
        this.ports.telemetryPort.terminal(outcome);
    }

    private isCurrent(generation: number, controller: AbortController): boolean
    {
        return this.isCurrentGeneration(generation)
      && this.preparationController === controller
      && !controller.signal.aborted;
    }

    private isCurrentGeneration(generation: number): boolean
    {
        return this.state.generation === generation;
    }

    /**
   * Frame-gated foreground feedback:
   * 1. mark busy immediately on the intent task;
   * 2. schedule one animation frame;
   * 3. show the loader only if this generation is still non-terminal;
   * 4. cancel before that frame when activation finishes in the same frame.
   */
    private scheduleForegroundFeedback(generation: number, intent: PublicActivationIntent): void
    {
        this.clearFeedback();
        this.feedbackBusy = true;
        this.ports.feedbackPort.markBusy(intent);
        this.feedbackFrame = this.ports.clock.requestFrame(() =>
        {
            this.feedbackFrame = null;
            if (!this.isCurrentGeneration(generation))
            {
                return;
            }
            if (this.state.phase === 'interactive' || this.state.phase === 'fallback')
            {
                return;
            }
            this.ports.feedbackPort.show(intent);
            this.state = { ...this.state, foregroundFeedbackVisible: true };
            this.ports.onStateChange?.(this.state);
        });
    }

    private clearFeedback(): void
    {
        if (this.feedbackFrame !== null)
        {
            this.ports.clock.cancelFrame(this.feedbackFrame);
            this.feedbackFrame = null;
        }
        if (this.feedbackBusy || this.state.foregroundFeedbackVisible)
        {
            this.ports.feedbackPort.hide();
            this.feedbackBusy = false;
            if (this.state.foregroundFeedbackVisible)
            {
                this.state = { ...this.state, foregroundFeedbackVisible: false };
                this.ports.onStateChange?.(this.state);
            }
        }
    }
}
