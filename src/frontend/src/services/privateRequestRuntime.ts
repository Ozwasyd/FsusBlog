import type { PrivateRequestScope } from '@/contracts/binaryTransport';

export type { PrivateRequestScope } from '@/contracts/binaryTransport';
export type PrivateRequestGenerationScope = Exclude<PrivateRequestScope, 'public'>;

export class StalePrivateResponseError extends Error
{
    readonly scope: PrivateRequestGenerationScope;

    constructor(scope: PrivateRequestGenerationScope)
    {
        super(`stale_private_response:${scope}`);
        this.name = 'AbortError';
        this.scope = scope;
    }
}

export type PrivateRequestLease = Readonly<{
    scope: PrivateRequestScope;
    generation: number | null;
    signal: AbortSignal | undefined;
    assertCurrent: () => void;
    release: () => void;
}>;

class PrivateRequestRuntime
{
    private readonly generations: Record<PrivateRequestGenerationScope, number> = {
        account: 0,
        admin: 0
    };

    private readonly controllers: Record<PrivateRequestGenerationScope, Set<AbortController>> = {
        account: new Set(),
        admin: new Set()
    };

    get authGeneration(): number
    {
        return this.generations.account;
    }

    get adminSessionGeneration(): number
    {
        return this.generations.admin;
    }

    currentGeneration(scope: PrivateRequestGenerationScope): number
    {
        return this.generations[scope];
    }

    open(
        scope: PrivateRequestScope,
        callerSignal?: AbortSignal,
        options: { abortOnGenerationChange?: boolean; } = {}
    ): PrivateRequestLease
    {
        if (scope === 'public')
        {
            return {
                scope,
                generation: null,
                signal: callerSignal,
                assertCurrent: () =>
                {},
                release: () =>
                {}
            };
        }

        const generation = this.generations[scope];
        const controller = new AbortController();
        const abortOnGenerationChange = options.abortOnGenerationChange !== false;
        if (abortOnGenerationChange)
        {
            this.controllers[scope].add(controller);
        }

        const forwardCallerAbort = (): void => controller.abort(callerSignal?.reason);
        if (callerSignal?.aborted)
        {
            forwardCallerAbort();
        }
        else
        {
            callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });
        }

        let released = false;
        return {
            scope,
            generation,
            signal: controller.signal,
            assertCurrent: () =>
            {
                if (generation !== this.generations[scope])
                {
                    throw new StalePrivateResponseError(scope);
                }
            },
            release: () =>
            {
                if (released)
                {
                    return;
                }
                released = true;
                this.controllers[scope].delete(controller);
                callerSignal?.removeEventListener('abort', forwardCallerAbort);
            }
        };
    }

    advance(scope: PrivateRequestGenerationScope): number
    {
        this.generations[scope] += 1;
        for (const controller of this.controllers[scope])
        {
            controller.abort(new StalePrivateResponseError(scope));
        }
        this.controllers[scope].clear();
        return this.generations[scope];
    }

    advanceForAuthTransition(reason: 'logout' | 'admin-logout' | 'account-switch' | 'session-expired'): number
    {
        return this.advance(reason === 'admin-logout' ? 'admin' : 'account');
    }

    resetForTests(): void
    {
        for (const scope of ['account', 'admin'] as const)
        {
            for (const controller of this.controllers[scope])
            {
                controller.abort();
            }
            this.controllers[scope].clear();
            this.generations[scope] = 0;
        }
    }
}

export const privateRequestRuntime = new PrivateRequestRuntime();

export async function runPrivateRequest<T>(
    scope: PrivateRequestGenerationScope,
    callerSignal: AbortSignal | undefined,
    request: (signal: AbortSignal) => Promise<T>
): Promise<T>
{
    const lease = privateRequestRuntime.open(scope, callerSignal);
    try
    {
        const value = await request(lease.signal!);
        lease.assertCurrent();
        return value;
    }
    finally
    {
        lease.release();
    }
}
