import { readonly, ref, shallowRef, type Ref } from 'vue';

import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import type { PrivateStateCleanupTrigger } from '@/services/privateStorageRegistry';

export type PrivateSurfaceTransition = Extract<
    PrivateStateCleanupTrigger,
  'logout' | 'admin-logout' | 'account-switch' | 'session-expired'
>;

export type PrivateSurfaceTerminationHandler = (reason: PrivateSurfaceTransition) => void | Promise<void>;
export type PrivateSurfaceNavigationHandler = (reason: PrivateSurfaceTransition) => void | Promise<void>;

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
    private readonly generationState = shallowRef(createOpaqueGeneration());
    private readonly clearingState = ref(false);
    private readonly terminationHandlers = new Set<PrivateSurfaceTerminationHandler>();
    private navigationHandler: PrivateSurfaceNavigationHandler | null = null;
    private transition: Promise<void> | null = null;

    readonly authGeneration: Readonly<Ref<string>> = readonly(this.generationState);
    readonly isClearing: Readonly<Ref<boolean>> = readonly(this.clearingState);

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
    // These writes are deliberately synchronous: Vue removes the old private
    // route tree on the next render tick before storage cleanup can yield.
        this.clearingState.value = true;
        this.generationState.value = createOpaqueGeneration();
        privateRequestRuntime.advanceForAuthTransition(reason);
        const previousTransition = this.transition;
        let currentTransition: Promise<void> | null = null;
        currentTransition = (async () =>
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
                    if (navigationComplete)
                    {
                        this.clearingState.value = false;
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
        this.terminationHandlers.clear();
        this.navigationHandler = null;
        this.transition = null;
        this.clearingState.value = false;
        this.generationState.value = createOpaqueGeneration();
    }
}

export const privateSurfaceRuntime = new PrivateSurfaceRuntime();
