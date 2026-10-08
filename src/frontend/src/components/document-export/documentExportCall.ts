/** Transport uncertainty is separate from every server-owned export job status. */
export type DocumentExportCallFailure = 'uncertain' | 'rejected' | 'permission-revoked';

export type DocumentExportCallState<TResult> =
    | { phase: 'idle'; }
    | { phase: 'pending'; }
    | { phase: 'confirmed'; result: TResult; }
    | { phase: DocumentExportCallFailure; };

export interface DocumentExportCallOptions<TRequest, TResult> {
    captureRequest: (request: TRequest) => TRequest;
    execute: (request: TRequest) => Promise<TResult>;
    classifyFailure: (error: unknown) => DocumentExportCallFailure;
    changed: (state: DocumentExportCallState<TResult>) => void;
    permissionRevoked: () => void;
    allowUncertainRetry: boolean;
}

/**
 * Coordinates one transient UI command against the canonical job adapter.
 * It never allocates a task, synthesizes a receipt, persists state, or retries
 * automatically. A retry reuses the exact admitted request/idempotency identity.
 * Reset invalidates late responses on identity change or permission revocation.
 */
export function createDocumentExportCall<TRequest, TResult>(
    options: DocumentExportCallOptions<TRequest, TResult>
)
{
    let epoch = 0;
    let pending: Promise<void> | null = null;
    let request: TRequest | undefined;
    let hasRequest = false;
    let phase: DocumentExportCallState<TResult>['phase'] = 'idle';

    function publish(state: DocumentExportCallState<TResult>): void
    {
        phase = state.phase;
        options.changed(state);
    }

    function reset(): void
    {
        epoch += 1;
        pending = null;
        request = undefined;
        hasRequest = false;
        publish({ phase: 'idle' });
    }

    function run(): Promise<void>
    {
        if (pending)
        {
            return pending;
        }
        const callEpoch = epoch;
        const submittedRequest = request as TRequest;
        const completion = Promise.resolve().then(async () =>
        {
            if (epoch !== callEpoch)
            {
                return;
            }
            try
            {
                const result = await options.execute(submittedRequest);
                if (epoch === callEpoch)
                {
                    publish({ phase: 'confirmed', result });
                }
            }
            catch (error: unknown)
            {
                if (epoch !== callEpoch)
                {
                    return;
                }
                const failure = options.classifyFailure(error);
                if (failure === 'permission-revoked')
                {
                    reset();
                    options.permissionRevoked();
                }
                publish({ phase: failure });
            }
        }).finally(() =>
        {
            if (epoch === callEpoch)
            {
                pending = null;
            }
        });
        pending = completion;
        publish({ phase: 'pending' });
        return completion;
    }

    function start(nextRequest: TRequest): Promise<void>
    {
        if (pending)
        {
            return pending;
        }
        // An uncertain write must be reconciled or explicitly retried before a
        // different request can be submitted, even if the panel was closed.
        if (phase === 'uncertain' || phase === 'permission-revoked')
        {
            return Promise.resolve();
        }
        request = options.captureRequest(nextRequest);
        hasRequest = true;
        return run();
    }

    function retry(): Promise<void>
    {
        if (pending)
        {
            return pending;
        }
        if (!hasRequest || phase !== 'uncertain' || !options.allowUncertainRetry)
        {
            return Promise.resolve();
        }
        return run();
    }

    return { start, retry, reset };
}
