import { computed, ref, shallowRef, type Ref } from 'vue';

import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import type { PrivateStateCleanupTrigger } from '@/services/privateStorageRegistry';

export type PrivateSurfaceTransition = Extract<
    PrivateStateCleanupTrigger,
  'logout' | 'admin-logout' | 'account-switch' | 'session-expired'
>;

export type PrivateSurfaceTerminationHandler = (reason: PrivateSurfaceTransition) => void | Promise<void>;
export type PrivateSurfaceNavigationHandler = (reason: PrivateSurfaceTransition) => void | Promise<void>;

/** The superseded operation cannot confirm that its requested cleanup ran. */
export class PrivateSurfaceCleanupIncompleteError extends Error
{
    constructor()
    {
        super('Private-surface cleanup completion was not confirmed before supersession.');
        this.name = 'PrivateSurfaceCleanupIncompleteError';
    }
}

declare const privateSurfaceAuthoritySealBrand: unique symbol;

/** Process-local custody only; copying or serializing this token loses authority. */
export type PrivateSurfaceAuthoritySeal = Readonly<{
    [privateSurfaceAuthoritySealBrand]: true;
}>;

function createOpaqueGeneration(): string
{
    const runtimeCrypto = globalThis.crypto;
    if (runtimeCrypto && typeof runtimeCrypto.randomUUID === 'function')
    {
        return runtimeCrypto.randomUUID();
    }

    const entropy = Math.random().toString(36).slice(2);
    return `private-surface-${Date.now().toString(36)}-${entropy}`;
}

interface PrivateSurfaceReservation {
    completion: Promise<void> | null;
}

class PrivateSurfaceRuntime
{
    readonly #generationState = shallowRef(createOpaqueGeneration());
    readonly #clearingState = ref(false);
    readonly #authoritySeals = new WeakMap<PrivateSurfaceAuthoritySeal, object>();
    #authorityEpoch: object | null = {};
    private readonly terminationHandlers = new Set<PrivateSurfaceTerminationHandler>();
    private navigationHandler: PrivateSurfaceNavigationHandler | null = null;
    #transition: PrivateSurfaceReservation | null = null;

    readonly authGeneration: Readonly<Ref<string>> = computed(() => this.#generationState.value);
    readonly isClearing: Readonly<Ref<boolean>> = computed(() => this.#clearingState.value);

    /** Reserve this original surface epoch; no auth admission is implied. */
    sealAuthority(): PrivateSurfaceAuthoritySeal | null
    {
        if (this.#authorityEpoch === null)
        {
            return null;
        }
        const epoch = this.#authorityEpoch;
        const seal = Object.freeze({}) as PrivateSurfaceAuthoritySeal;
        if (epoch !== this.#authorityEpoch)
        {
            return null;
        }
        this.#authoritySeals.set(seal, epoch);
        return seal;
    }

    /** Pure private lookup: no reactive reads, allocation, clock, or callbacks. */
    hasAuthorityCustody(seal: PrivateSurfaceAuthoritySeal): boolean
    {
        return this.#authorityEpoch !== null && this.#authoritySeals.get(seal) === this.#authorityEpoch;
    }

    cancelAuthority(seal: PrivateSurfaceAuthoritySeal): boolean
    {
        return this.#authoritySeals.delete(seal);
    }

    setNavigationHandler(handler: PrivateSurfaceNavigationHandler | null): void
    {
        this.navigationHandler = handler;
    }

    registerTerminationHandler(handler: PrivateSurfaceTerminationHandler): () => void
    {
        this.terminationHandlers.add(handler);
        return () => this.terminationHandlers.delete(handler);
    }

    invalidate(
        reason: PrivateSurfaceTransition,
        clearPrivateState: () => void | Promise<void>
    ): Promise<void>
    {
        // Revoke before reactive observers, entropy allocation, request aborts,
        // termination, or cleanup can reenter the original producer.
        this.#authorityEpoch = null;
        const previousTransition = this.#transition;
        const reservation: PrivateSurfaceReservation = { completion: null };
        // Reserve ownership before even Promise construction can reenter.
        this.#transition = reservation;
        const settlement: {
            resolve?: () => void;
            reject?: (reason: unknown) => void;
        } = {};
        const currentTransition = new Promise<void>((resolve, reject) =>
        {
            settlement.resolve = resolve;
            settlement.reject = reject;
        });
        reservation.completion = currentTransition;
        // This completion belongs only to its already-published reservation;
        // assigning it cannot replace a newer transition.
        const performTransition = async (): Promise<void> =>
        {
            if (this.#transition !== reservation)
            {
                throw new PrivateSurfaceCleanupIncompleteError();
            }
            this.#clearingState.value = true;
            if (this.#transition !== reservation)
            {
                throw new PrivateSurfaceCleanupIncompleteError();
            }
            const generation = createOpaqueGeneration();
            if (this.#transition !== reservation)
            {
                throw new PrivateSurfaceCleanupIncompleteError();
            }
            this.#generationState.value = generation;
            if (this.#transition !== reservation)
            {
                throw new PrivateSurfaceCleanupIncompleteError();
            }
            privateRequestRuntime.advanceForAuthTransition(reason);
            if (this.#transition !== reservation)
            {
                throw new PrivateSurfaceCleanupIncompleteError();
            }
            if (previousTransition?.completion)
            {
                await previousTransition.completion.catch(() =>
                {
                    // A failed earlier cleanup must not prevent this transition.
                });
            }
            if (this.#transition !== reservation)
            {
                throw new PrivateSurfaceCleanupIncompleteError();
            }

            const terminationOutcomes: Promise<void>[] = [];
            for (const handler of [...this.terminationHandlers])
            {
                if (this.#transition !== reservation)
                {
                    // Observe already-started outcomes without waiting on a
                    // callback that may itself depend on the newer transition.
                    void Promise.allSettled(terminationOutcomes);
                    throw new PrivateSurfaceCleanupIncompleteError();
                }
                try
                {
                    terminationOutcomes.push(Promise.resolve(handler(reason)));
                }
                catch (error)
                {
                    // Preserve the exact callback exception as an immediate
                    // rejection, including values that are not Error instances.
                    terminationOutcomes.push(new Promise<never>(() =>
                    {
                        throw error;
                    }));
                }
            }
            if (this.#transition !== reservation)
            {
                void Promise.allSettled(terminationOutcomes);
                throw new PrivateSurfaceCleanupIncompleteError();
            }
            let clearOutcome: Promise<void>;
            try
            {
                clearOutcome = Promise.resolve(clearPrivateState());
            }
            catch (error)
            {
                clearOutcome = new Promise<never>(() =>
                {
                    throw error;
                });
            }
            if (this.#transition !== reservation)
            {
                void Promise.allSettled([...terminationOutcomes, clearOutcome]);
                throw new PrivateSurfaceCleanupIncompleteError();
            }
            let navigationComplete = this.navigationHandler === null;
            try
            {
                const outcomes = await Promise.allSettled([...terminationOutcomes, clearOutcome]);
                const clearResult = outcomes.at(-1);
                // Completion is independent of state ownership. A newer
                // reservation cannot turn a cleanup rejection into fulfillment.
                const requireCleanupCompletion = (): void =>
                {
                    if (clearResult?.status === 'rejected')
                    {
                        throw clearResult.reason;
                    }
                    if (clearResult?.status !== 'fulfilled')
                    {
                        throw new PrivateSurfaceCleanupIncompleteError();
                    }
                };
                if (this.#transition !== reservation)
                {
                    requireCleanupCompletion();
                    return;
                }
                const navigationOutcome = Promise.resolve(this.navigationHandler?.(reason));
                if (this.#transition !== reservation)
                {
                    void Promise.allSettled([navigationOutcome]);
                    requireCleanupCompletion();
                    return;
                }
                await navigationOutcome;
                navigationComplete = true;
                requireCleanupCompletion();
            }
            finally
            {
                // Only the same reservation can restore admission. A reentrant
                // transition owns both clearing and its own completion promise.
                if (this.#transition === reservation)
                {
                    if (navigationComplete)
                    {
                        this.#authorityEpoch = {};
                        this.#clearingState.value = false;
                    }
                    if (this.#transition === reservation)
                    {
                        this.#transition = null;
                    }
                }
            }
        };
        void performTransition().then(settlement.resolve, settlement.reject);
        return currentTransition;
    }

    resetForTests(): void
    {
        this.#authorityEpoch = null;
        const reservation: PrivateSurfaceReservation = { completion: null };
        this.#transition = reservation;
        this.terminationHandlers.clear();
        this.navigationHandler = null;
        this.#generationState.value = createOpaqueGeneration();
        if (this.#transition === reservation)
        {
            this.#authorityEpoch = {};
            this.#clearingState.value = false;
            if (this.#transition === reservation)
            {
                this.#transition = null;
            }
        }
    }
}

export const privateSurfaceRuntime = new PrivateSurfaceRuntime();
