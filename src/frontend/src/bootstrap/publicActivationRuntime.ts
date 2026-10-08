import { readonly, shallowRef } from 'vue';

import type * as FullAppExports from '@/bootstrap/fullApp';
import {
    PublicActivationCoordinator,
    createPublicBootActivationIntent,
    type PublicActivationIntent,
    type PublicActivationOutcome,
    type PublicActivationOwner,
    type PublicCoreWarmResult,
    type PublicRoutePreparationResult,
    type PublicActivationState
} from '@/bootstrap/publicActivationCoordinator';
import type { PublicBootIntent } from '@/bootstrap/publicBootHandoff';
import {
    markGlobalLoaderBusy,
    removeGlobalLoader,
    showGlobalLoader
} from '@/bootstrap/publicShellPrimitives';
import { prewarmPublicRoute } from '@/router/publicRoutePreload';
import { emitTelemetry } from '@/services/telemetryBus';

type FullAppModule = typeof FullAppExports;
type PreparedFullApp = ReturnType<FullAppModule['prepareFullApp']>;

const initialState: PublicActivationState = {
    generation: 0,
    intent: null,
    phase: 'static-visible',
    owner: 'aot',
    foregroundFeedbackVisible: false,
    failureReason: null,
    replaceable: true
};
const state = shallowRef<PublicActivationState>(initialState);
let preparedFullApp: PreparedFullApp | null = null;
let preparedCandidate: PreparedFullApp | null = null;
let coreModulePromise: Promise<FullAppModule> | null = null;
let bootIntentAdopted = false;

function currentTarget(): string
{
    return `${window.location.pathname}${window.location.search}${window.location.hash}` || '/';
}

function toAbsoluteHref(target: string): string
{
    return new URL(target, window.location.href).toString();
}

type FullAppActivationOwner = Exclude<PublicActivationOwner, 'document-navigation'>;

function getFullAppActivationOwner(): FullAppActivationOwner
{
    return state.value.owner === 'full-app' ? 'full-app' : 'aot';
}

/**
 * FullApp core warm: dynamic-import the SPA entry only.
 * Does not accept a route URL and must not touch route seed/head stores.
 */
async function loadFullApp(): Promise<FullAppModule>
{
    coreModulePromise ??= import('@/bootstrap/fullApp').catch((error) =>
    {
        coreModulePromise = null;
        throw error;
    });
    return await coreModulePromise;
}

const coordinator = new PublicActivationCoordinator<PreparedFullApp>({
    routePreparationPort: {
    // Intent route preparation only: component + snapshot + SEO seed.
    // Never creates/mounts a Vue app or imports FullApp composition root.
        prepare: async (intent, signal) =>
        {
            const result = await prewarmPublicRoute(intent.target, {
                reason: intent.kind === 'navigate' ? 'atomic-navigation' : intent.source === 'idle' ? 'idle' : 'pointerenter',
                signal
            });
            return {
                ready: result.status === 'ready',
                reason: result.status === 'ready'
                    ? undefined
                    : (result.error ?? result.status),
                routeComponentMs: result.routeComponentMs,
                routeSnapshotMs: result.routeSnapshotMs
            };
        }
    },
    fullAppPort: {
        warm: async () =>
        {
            await loadFullApp();
        },
        prepare: async () =>
        {
            if (preparedCandidate)
            {
                return preparedCandidate;
            }
            const module = await loadFullApp();
            // prepareFullApp constructs app/router/plugins without mounting and without
            // requesting any public route navigation snapshot.
            preparedCandidate = module.prepareFullApp({
                getPublicActivationOwner: getFullAppActivationOwner,
                shouldSuppressNavigationProgress: () => state.value.phase !== 'interactive',
                takeover: 'public-shell'
            });
            return preparedCandidate;
        },
        commit: async (prepared, intent) =>
        {
            const module = await loadFullApp();
            await module.commitPreparedFullApp(prepared, intent.kind === 'navigate'
                ? { navigationIntent: { to: intent.target } }
                : {});
            preparedFullApp = prepared;
            preparedCandidate = null;
        },
        navigate: async (intent) =>
        {
            if (!preparedFullApp)
            {
                throw new Error('interactive FullApp is unavailable');
            }
            await preparedFullApp.router.push(intent.target);
        }
    },
    feedbackPort: {
        markBusy: () => markGlobalLoaderBusy(),
        show: () => showGlobalLoader(),
        hide: () => removeGlobalLoader()
    },
    fallbackPort: {
        navigate: (intent) => window.location.assign(toAbsoluteHref(intent.target))
    },
    telemetryPort: {
        phase: (from, to, snapshot, durationMs) => emitTelemetry('public_activation_phase', {
            durationMs,
            from,
            generation: snapshot.generation,
            owner: snapshot.owner,
            source: snapshot.intent?.source,
            target: snapshot.intent?.target,
            to
        }, 'info'),
        illegalTransition: (from, to, reason) => emitTelemetry('public_activation_illegal_transition', {
            from,
            reason,
            to
        }, 'warn'),
        terminal: (outcome) => emitTelemetry('public_activation_terminal', outcome, outcome.status === 'fallback' ? 'warn' : 'info'),
        prepareTiming: (timing) => emitTelemetry('public_activation_prepare_timing', timing, 'info')
    },
    clock: {
        now: () => performance.now(),
        queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
        setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimer: (handle) => window.clearTimeout(handle),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (handle) => window.cancelAnimationFrame(handle)
    },
    onStateChange: (snapshot) =>
    {
        state.value = snapshot;
    }
});

export const publicActivationState = readonly(state);

export function getPublicActivationOwner(): PublicActivationState['owner']
{
    return state.value.owner;
}

/** Idle FullApp core warming — no route URL, no navigation snapshot. */
export function warmPublicFullAppCore(): Promise<PublicCoreWarmResult>
{
    return coordinator.warmCore();
}

/** Intent-targeted route preparation (pointerenter/focus). Does not commit FullApp. */
export function warmPublicActivation(
    target = currentTarget(),
    source = 'pointerenter'
): Promise<PublicRoutePreparationResult>
{
    return coordinator.warm(target, source);
}

export function submitPublicActivationIntent(intent: PublicActivationIntent): Promise<PublicActivationOutcome>
{
    return coordinator.submitIntent(intent);
}

/**
 * Typed search-focus UI intent.
 * Prewarms `/search` and activates FullApp ownership on the current path.
 * Only the AOT public shell surface may accept this intent; FullApp/document
 * owners and direct SPA boots no-op. Never dispatches window CustomEvents.
 */
export function requestPublicSearchFocusIntent(): void
{
    if (getPublicActivationOwner() !== 'aot')
    {
        return;
    }

    if (typeof document !== 'undefined' && !document.querySelector('#fsus-aot-shell'))
    {
        return;
    }

    void warmPublicActivation('/search', 'search-focus').catch(() =>
    {
        // Foreground activation owns fallback; speculative warming stays optional.
    });
    void submitPublicActivationIntent({
        kind: 'activate',
        source: 'search-focus',
        target: currentTarget()
    }).catch(() =>
    {
        // The coordinator owns terminal fallback; this UI intent has no further action.
    });
}

export function adoptPublicBootIntent(intent: PublicBootIntent | null): void
{
    if (bootIntentAdopted || !intent)
    {
        return;
    }
    bootIntentAdopted = true;
    void coordinator.submitIntent(createPublicBootActivationIntent(intent, currentTarget()));
}
