import { computed, ref, shallowRef, type Ref } from 'vue';

import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import type { PrivateStateCleanupTrigger } from '@/services/privateStorageRegistry';

export type PrivateSurfaceTransition = Extract<
    PrivateStateCleanupTrigger,
  'logout' | 'admin-logout' | 'account-switch' | 'session-expired'
>;

export type PrivateSurfaceTerminationHandler = (reason: PrivateSurfaceTransition) => void | Promise<void>;
export type PrivateSurfaceNavigationHandler = (reason: PrivateSurfaceTransition) => void | Promise<void>;

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

class PrivateSurfaceRuntime
{
    readonly #generationState = shallowRef(createOpaqueGeneration());
    readonly #clearingState = ref(false);
    readonly #authoritySeals = new WeakMap<PrivateSurfaceAuthoritySeal, object>();
    #authorityEpoch: object | null = {};
    #authorityTransition: object | null = null;
    private readonly terminationHandlers = new Set<PrivateSurfaceTerminationHandler>();
    private navigationHandler: PrivateSurfaceNavigationHandler | null = null;
    private transition: Promise<void> | null = null;

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
        const authorityTransition = {};
        this.#authorityTransition = authorityTransition;
        // These writes are deliberately synchronous: Vue removes the old private
        // route tree on the next render tick before storage cleanup can yield.
        this.#clearingState.value = true;
        this.#generationState.value = createOpaqueGeneration();
        privateRequestRuntime.advanceForAuthTransition(reason);
        const previousTransition = this.transition;
        const currentTransition = (async () =>
        {
            if (previousTransition)
            {
                await previousTransition.catch(() =>
                {});
            }

            const terminationOutcomes = [...this.terminationHandlers].map(handler =>
            {
                try
                {
                    return Promise.resolve(handler(reason));
                }
                catch (error)
                {
                    return Promise.reject(error);
                }
            });
            let clearOutcome: Promise<void>;
            try
            {
                clearOutcome = Promise.resolve(clearPrivateState());
            }
            catch (error)
            {
                clearOutcome = Promise.reject(error);
            }
            let navigationComplete = this.navigationHandler === null;
            try
            {
                const outcomes = await Promise.allSettled([...terminationOutcomes, clearOutcome]);
                const clearResult = outcomes.at(-1);
                await this.navigationHandler?.(reason);
                navigationComplete = true;
                if (clearResult?.status === 'rejected')
                {
                    throw clearResult.reason;
                }
            }
            finally
            {
                // A failed redirect must remain fail-closed instead of remounting the
                // old private tree. A later successful transition can recover it.
                if (this.transition === currentTransition)
                {
                    if (navigationComplete && authorityTransition === this.#authorityTransition)
                    {
                        this.#authorityEpoch = {};
                        this.#clearingState.value = false;
                    }
                    this.transition = null;
                }
            }
        })();
        this.transition = currentTransition;

        return currentTransition;
    }

    resetForTests(): void
    {
        this.#authorityEpoch = null;
        const authorityTransition = {};
        this.#authorityTransition = authorityTransition;
        this.terminationHandlers.clear();
        this.navigationHandler = null;
        this.transition = null;
        this.#generationState.value = createOpaqueGeneration();
        if (authorityTransition === this.#authorityTransition)
        {
            this.#authorityEpoch = {};
            this.#clearingState.value = false;
        }
    }
}

export const privateSurfaceRuntime = new PrivateSurfaceRuntime();
