import { privateRequestRuntime, type PrivateRequestLease } from '@/services/privateRequestRuntime';
import { registerPrivateStateCleanupHandler } from '@/services/privateStorageRegistry';

/** Local request sequencing only; this does not authorize or execute any query. */
export interface AuthorQueryRequestLease {
    readonly requestId: string;
    readonly requestSequence: number;
    readonly scopeDigest: string;
    readonly adminGeneration: number;
    readonly signal: AbortSignal;
    assertCurrent(): void;
    release(): void;
}

/** One in-flight query slot bound to the existing private admin generation owner. */
export class AuthorQueryRequestCoordinator
{
    private sequence = 0;
    private active: Readonly<{ sequence: number; controller: AbortController; lease: PrivateRequestLease; cleanup: () => void; }> | null = null;
    private disposed = false;
    private cleanupDepth = 0;
    private readonly unregisterCleanup: () => void;

    constructor()
    {
        this.unregisterCleanup = registerPrivateStateCleanupHandler('author-query-projection-runtime', () =>
        {
            this.cleanupDepth += 1;
            try
            {
                this.cancel();
            }
            finally
            {
                this.cleanupDepth -= 1;
            }
        });
    }

    begin(scopeDigest: string, callerSignal?: AbortSignal): AuthorQueryRequestLease
    {
        if (this.disposed || this.cleanupDepth > 0 || !/^[a-f0-9]{64}$/.test(scopeDigest) || this.sequence >= Number.MAX_SAFE_INTEGER)
        {
            throw new Error('author_query_request_invalid');
        }
        const sequence = ++this.sequence;
        this.cancel();
        if (this.disposed || this.sequence !== sequence)
        {
            throw new DOMException('author_query_request_stale', 'AbortError');
        }
        const controller = new AbortController();
        const forwardAbort = (): void => controller.abort(callerSignal?.reason);
        if (callerSignal?.aborted)
        {
            forwardAbort();
        }
        else
        {
            callerSignal?.addEventListener('abort', forwardAbort, { once: true });
        }
        const privateLease = privateRequestRuntime.open('admin', controller.signal);
        const cleanup = (): void =>
        {
            callerSignal?.removeEventListener('abort', forwardAbort);
            privateLease.release();
        };
        this.active = { sequence, controller, lease: privateLease, cleanup };
        let released = false;
        return Object.freeze({
            requestId: crypto.randomUUID(),
            requestSequence: sequence,
            scopeDigest,
            adminGeneration: privateLease.generation!,
            signal: privateLease.signal!,
            assertCurrent: (): void =>
            {
                privateLease.assertCurrent();
                if (released || this.disposed || this.active?.sequence !== sequence || privateLease.signal!.aborted)
                {
                    throw new DOMException('author_query_request_stale', 'AbortError');
                }
            },
            release: (): void =>
            {
                if (released)
                {
                    return;
                }
                released = true;
                cleanup();
                if (this.active?.sequence === sequence)
                {
                    this.active = null;
                }
            }
        });
    }

    cancel(): void
    {
        const active = this.active;
        this.active = null;
        active?.controller.abort(new DOMException('author_query_request_canceled', 'AbortError'));
        active?.cleanup();
    }

    dispose(): void
    {
        if (!this.disposed)
        {
            this.disposed = true;
            this.cancel();
            this.unregisterCleanup();
        }
    }
}
