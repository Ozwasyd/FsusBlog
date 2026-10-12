/** Observable custody belongs to this invocation; shared codec/native internals remain outside it. */
export interface ImageProducerResource {
    readonly id: number;
    readonly kind: string;
    readonly scope: 'local' | 'third-party';
    readonly terminal: 'active' | 'settled' | 'unknown';
    readonly retained: boolean;
    readonly cancellationSupported: boolean;
    readonly cancellationRequested: boolean;
    readonly cleanupFailed: boolean;
}

/** A frozen diagnostic snapshot contains no original input, native handle, or release authority. */
export interface ImageProducerResourceCensus {
    readonly invocation: 'pending' | 'finished';
    readonly local: 'active' | 'settled' | 'unknown';
    readonly cancellationRequested: boolean;
    readonly resources: readonly ImageProducerResource[];
}

/** Actual cleanup/cancellation exceptions remain available separately from the public census. */
export interface ImageProducerCleanupError {
    readonly resourceId: number;
    readonly action: 'cancel' | 'cleanup';
    readonly cause: unknown;
}

/**
 * `result` is the original invocation. `settled` observes its finite local work and owned cleanup,
 * including failure/cancellation; it can remain pending after a cleanup failure until retry succeeds.
 * Neither promise proves shared codec disposal, whole-upload readiness, or business asset cleanup.
 */
export interface ImageProducerOperation<T> {
    readonly result: Promise<T>;
    readonly settled: Promise<void>;
    cancelLocal(reason?: unknown): void;
    inspectLocalResources(): ImageProducerResourceCensus;
    inspectCleanupErrors(): readonly ImageProducerCleanupError[];
    retryCleanup(): void;
}

interface OwnedResource {
    id: number;
    kind: string;
    scope: 'local' | 'third-party';
    terminal: 'active' | 'settled' | 'unknown';
    handle?: unknown;
    cleanup?: () => void;
    cancel?: () => void;
    cancellationSupported: boolean;
    cancellationRequested: boolean;
    cleanupFailed: boolean;
    releasable: boolean;
}

/** Internal custodian used only by the original image/hash producers. */
export interface ImageProducerOwner {
    hold(kind: string, handle: unknown, cleanup?: () => void, cancel?: () => void): OwnedResource;
    release(resource: OwnedResource, propagateError?: boolean): void;
    observe<T>(kind: string, start: () => Promise<T>): Promise<T>;
    noteThirdParty(kind: string): void;
    ensureActive(): void;
    isCancellationRequested(): boolean;
}

/** Runs one producer, retaining failed cleanup handles without a timer, replacement run, or native ACK. */
export function createImageProducerOperation<T>(
    run: (owner: ImageProducerOwner) => Promise<T>,
    signal?: AbortSignal
): ImageProducerOperation<T>
{
    const resources: OwnedResource[] = [];
    const cleanupErrors: ImageProducerCleanupError[] = [];
    let finished = false;
    let locallySettled = false;
    let cancellationRequested = false;
    let cancellationReason: unknown;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) =>
    {
        resolveSettled = resolve;
    });

    function trySettle(): void
    {
        if (finished && !locallySettled && resources.every((resource) =>
            resource.scope !== 'local' || resource.terminal === 'settled'))
        {
            locallySettled = true;
            cancellationReason = undefined;
            resolveSettled();
        }
    }

    function release(resource: OwnedResource, propagateError = false): void
    {
        if (resource.scope !== 'local' || resource.terminal === 'settled')
        {
            return;
        }
        resource.releasable = true;
        try
        {
            resource.cleanup?.();
            resource.handle = undefined;
            resource.cleanup = undefined;
            resource.cancel = undefined;
            resource.cleanupFailed = false;
            resource.terminal = 'settled';
        }
        catch (cause)
        {
            resource.cleanupFailed = true;
            resource.terminal = 'unknown';
            cleanupErrors.push(Object.freeze({ resourceId: resource.id, action: 'cleanup', cause }));
            if (propagateError)
            {
                throw cause;
            }
        }
        trySettle();
    }

    function hold(kind: string, handle: unknown, cleanup?: () => void, cancel?: () => void): OwnedResource
    {
        const resource: OwnedResource = {
            id: resources.length + 1,
            kind,
            scope: 'local',
            terminal: 'active',
            handle,
            cleanup,
            cancel,
            cancellationSupported: Boolean(cancel),
            cancellationRequested: false,
            cleanupFailed: false,
            releasable: false
        };
        resources.push(resource);
        return resource;
    }

    function ensureActive(): void
    {
        if (cancellationRequested)
        {
            throw cancellationReason;
        }
    }

    function retryCleanup(): void
    {
        for (const resource of resources)
        {
            if (resource.releasable && resource.cleanupFailed)
            {
                release(resource);
            }
        }
    }

    function cancelLocal(reason?: unknown): void
    {
        if (locallySettled)
        {
            return;
        }
        if (!cancellationRequested)
        {
            cancellationRequested = true;
            cancellationReason = reason ?? new DOMException('Image producer cancellation requested', 'AbortError');
        }
        for (const resource of resources)
        {
            if (!resource.releasable && resource.cancel)
            {
                resource.cancellationRequested = true;
                try
                {
                    resource.cancel();
                }
                catch (cause)
                {
                    cleanupErrors.push(Object.freeze({ resourceId: resource.id, action: 'cancel', cause }));
                }
            }
        }
        retryCleanup();
    }

    const owner: ImageProducerOwner = {
        hold,
        release,
        ensureActive,
        isCancellationRequested: () => cancellationRequested,
        async observe<R>(kind: string, start: () => Promise<R>): Promise<R>
        {
            ensureActive();
            const resource = hold(kind, undefined);
            try
            {
                const promise = start();
                resource.handle = promise;
                return await promise;
            }
            finally
            {
                release(resource);
            }
        },
        noteThirdParty(kind: string): void
        {
            resources.push({
                id: resources.length + 1,
                kind,
                scope: 'third-party',
                terminal: 'unknown',
                cancellationSupported: false,
                cancellationRequested: false,
                cleanupFailed: false,
                releasable: false
            });
        }
    };

    const result = (async () =>
    {
        try
        {
            if (signal)
            {
                const originalSignal = signal;
                const onAbort = () => cancelLocal(originalSignal.reason);
                hold('abort-listener', originalSignal, () => originalSignal.removeEventListener('abort', onAbort));
                originalSignal.addEventListener('abort', onAbort, { once: true });
                if (originalSignal.aborted)
                {
                    onAbort();
                }
                signal = undefined;
            }
            ensureActive();
            return await run(owner);
        }
        finally
        {
            // Only the awaited original body makes remaining owned handles eligible for release.
            for (const resource of [...resources].reverse())
            {
                release(resource);
            }
            finished = true;
            trySettle();
        }
    })();

    return Object.freeze({
        result,
        settled,
        cancelLocal,
        retryCleanup,
        inspectCleanupErrors: () => Object.freeze([...cleanupErrors]),
        inspectLocalResources: (): ImageProducerResourceCensus => Object.freeze({
            invocation: finished ? 'finished' : 'pending',
            local: locallySettled ? 'settled' : finished ? 'unknown' : 'active',
            cancellationRequested,
            resources: Object.freeze(resources.map((resource) => Object.freeze({
                id: resource.id,
                kind: resource.kind,
                scope: resource.scope,
                terminal: resource.terminal,
                retained: resource.handle !== undefined || resource.cleanup !== undefined,
                cancellationSupported: resource.cancellationSupported,
                cancellationRequested: resource.cancellationRequested,
                cleanupFailed: resource.cleanupFailed
            })))
        })
    });
}
