import type { ImageUploadLocalResourceCensus } from '@/composables/useImageUploadRuntime';
import { articleAttachmentIntentCapacity } from '@/services/authoring/articleAttachmentContext';
import type { ArticleAttachmentUploadRequest } from '@/services/authoring/articleAttachmentUploadRequest';

import type { MarkdownAttachmentProviderResult } from '@ozwasyd/element-plus';

/** One real admission plan; the original File/handle/lease remain in Main's start closure. */
export interface ArticleAttachmentQueuedUploadRequest extends ArticleAttachmentUploadRequest {
    getStartedRequest(): ArticleAttachmentUploadRequest | null;
    inspectUploadResources(): ImageUploadLocalResourceCensus;
    inspectObservationFailures(): readonly Readonly<{ cause: unknown; }>[];
}

/** Serialize the existing runtime through actual full producer settlement, never content result. */
export function createArticleAttachmentUploadQueue()
{
    interface Entry {
        start: (() => ArticleAttachmentUploadRequest) | null;
        readonly signal: AbortSignal;
        detach: (() => void) | null;
        original: ArticleAttachmentUploadRequest | null;
        started: boolean;
        cancelled: boolean;
        cancelling: boolean;
        cancelPending: boolean;
        cleanupReentry: { cause: unknown; } | null;
        resultObserved: boolean;
        producerSettled: boolean;
        ended: boolean;
        readonly failures: { cause: unknown; }[];
        readonly resolveResult: (value: MarkdownAttachmentProviderResult) => void;
        readonly rejectResult: (cause: unknown) => void;
        readonly resolveSettled: () => void;
    }
    const queued: Entry[] = [];
    let active: Entry | null = null;

    const failure = (entry: Entry, cause: unknown): void =>
    {
        entry.failures.push({ cause });
    };
    const detach = (entry: Entry): void =>
    {
        entry.detach?.();
        entry.detach = null;
    };
    const reconsider = (entry: Entry): void =>
    {
        if (entry.ended || entry.cancelling || entry.cancelPending || !entry.resultObserved || !entry.producerSettled)
        {
            return;
        }
        try
        {
            detach(entry);
        }
        catch (cause)
        {
            failure(entry, cause);
            return;
        }
        entry.ended = true;
        if (active === entry)
        {
            active = null;
        }
        entry.resolveSettled();
        pump();
    };
    const cancel = (entry: Entry, reason?: string): void =>
    {
        if (entry.ended)
        {
            return;
        }
        entry.cancelled = true;
        entry.cancelPending = true;
        if (entry.cancelling)
        {
            const cause = new Error('article-native-upload-queue-cleanup-reentrant');
            entry.cleanupReentry = { cause };
            failure(entry, cause);
            throw cause;
        }
        entry.cancelling = true;
        entry.cleanupReentry = null;
        let failed = false;
        let firstCause: unknown;
        const run = (work: () => void): void =>
        {
            try
            {
                work();
            }
            catch (cause)
            {
                if (!failed)
                {
                    firstCause = cause;
                }
                failed = true;
                failure(entry, cause);
            }
        };
        try
        {
            run(() =>
            {
                if (entry.original)
                {
                    entry.original.cancelLocal(reason);
                }
                else if (!entry.started)
                {
                    const index = queued.indexOf(entry);
                    if (index >= 0)
                    {
                        queued.splice(index, 1);
                    }
                    entry.start = null;
                    entry.rejectResult(entry.signal.aborted ? entry.signal.reason : reason);
                    // This actual plan was removed without ever calling the runtime/provider.
                    entry.resultObserved = true;
                    entry.producerSettled = true;
                }
                else
                {
                    // Acquisition threw or reentered before its real original request escaped.
                    throw new Error('article-native-upload-queue-acquisition-unconfirmed');
                }
            });
            run(() => detach(entry));
            run(() =>
            {
                if (entry.cleanupReentry)
                {
                    throw entry.cleanupReentry.cause;
                }
            });
            if (failed)
            {
                throw firstCause;
            }
            entry.cancelPending = false;
        }
        finally
        {
            entry.cancelling = false;
            reconsider(entry);
        }
    };
    const pump = (): void =>
    {
        if (active)
        {
            return;
        }
        const entry = queued.shift();
        if (!entry)
        {
            return;
        }
        // Reserve synchronously before compression/hash or any original producer callback.
        active = entry;
        entry.started = true;
        const start = entry.start;
        entry.start = null;
        try
        {
            if (!start)
            {
                throw new Error('article-native-upload-queue-start-unavailable');
            }
            entry.original = start();
            const original = entry.original;
            // Observe only original producer futures; no native/SDK/UI application dependency.
            const relay = original.result.then(entry.resolveResult, entry.rejectResult);
            void relay.then(() =>
            {
                entry.resultObserved = true;
                reconsider(entry);
            }, (cause: unknown) => failure(entry, cause));
            void original.settled.then(() =>
            {
                entry.producerSettled = true;
                reconsider(entry);
            }, (cause: unknown) => failure(entry, cause));
            if (entry.cancelled || entry.signal.aborted)
            {
                cancel(entry, typeof entry.signal.reason === 'string' ? entry.signal.reason : undefined);
            }
        }
        catch (cause)
        {
            entry.rejectResult(cause);
            failure(entry, cause);
            // No escaped original request is not a zero-resource acquisition receipt.
            // Keep active custody and settlement pending; never start a competing generation.
        }
    };
    return Object.freeze({
        hasAdmission: () => active !== null || queued.length > 0,
        enqueue(signal: AbortSignal, start: () => ArticleAttachmentUploadRequest): ArticleAttachmentQueuedUploadRequest
        {
            signal.throwIfAborted();
            if (queued.length + Number(active !== null) >= articleAttachmentIntentCapacity)
            {
                throw new Error('article-native-upload-queue-capacity-exceeded');
            }
            let resolveResult!: (value: MarkdownAttachmentProviderResult) => void;
            let rejectResult!: (cause: unknown) => void;
            let resolveSettled!: () => void;
            const result = new Promise<MarkdownAttachmentProviderResult>((resolve, reject) =>
            {
                resolveResult = resolve;
                rejectResult = reject;
            });
            const settled = new Promise<void>((resolve) => resolveSettled = resolve);
            const entry: Entry = { start, signal, detach: null, original: null, started: false, cancelled: false,
                cancelling: false, cancelPending: false, cleanupReentry: null, resultObserved: false,
                producerSettled: false, ended: false, failures: [], resolveResult, rejectResult, resolveSettled };
            const onAbort = (): void =>
            {
                try
                {
                    cancel(entry, typeof signal.reason === 'string' ? signal.reason : undefined);
                }
                catch
                {
                    // The actual raw failure and unfinished holder remain inspectable/retriable.
                }
            };
            entry.detach = () => signal.removeEventListener('abort', onAbort);
            signal.addEventListener('abort', onAbort, { once: true });
            queued.push(entry);
            if (signal.aborted)
            {
                onAbort();
            }
            pump();
            return Object.freeze({ result, settled,
                get upload()
                {
                    if (!entry.original)
                    {
                        throw new Error('article-native-upload-queue-original-unavailable');
                    }
                    return entry.original.upload;
                },
                cancelLocal: (reason?: string) => cancel(entry, reason),
                getStartedRequest: () => entry.original,
                getProviderRequest: () => entry.original?.getProviderRequest() ?? null,
                inspectUploadResources: () =>
                {
                    if (!entry.original)
                    {
                        throw new Error('article-native-upload-queue-resource-census-unavailable');
                    }
                    return entry.original.inspectUploadResources();
                },
                inspectLocalResources: (): never =>
                {
                    // Original upload census does not include this queue's retained plan/listener.
                    throw new Error('article-native-upload-queue-resource-census-unavailable');
                },
                inspectObservationFailures: () => Object.freeze([...entry.failures,
                    ...entry.original?.inspectObservationFailures() ?? []].map(value => Object.freeze({ ...value })))
            });
        }
    });
}
