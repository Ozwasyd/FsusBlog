import type { ImageUploadFileCompletion } from '@/composables/useImageUploadFlow';
import { createArticleAttachmentUploadProvider } from '@/services/authoring/articleAttachmentUploadProvider';

import type {
    MarkdownAttachmentBatchIntent,
    MarkdownAttachmentConsumerRequest,
    MarkdownAttachmentItemIntent,
    MarkdownAttachmentProviderResult
} from '@ozwasyd/element-plus';

/** Read actual committed transport facts inside the original ACK loan, before native application. */
export function requestArticleAttachmentCommittedFacts(completion: ImageUploadFileCompletion,
    batch: MarkdownAttachmentBatchIntent, item: MarkdownAttachmentItemIntent): MarkdownAttachmentConsumerRequest
{
    const controller = new AbortController();
    const failures: { cause: unknown; }[] = [];
    let cancellationPending = false;
    let scopeCompleted = false;
    let scopeFinished = false;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) =>
    {
        resolveSettled = resolve;
    });
    const reconsider = (): void =>
    {
        if (scopeCompleted && !cancellationPending)
        {
            resolveSettled();
        }
    };
    // This future owns only its network read and nested loan scope. It never joins upload,
    // adapter, SDK acceptance or the native application that depends on its rich result.
    const result = completion.borrow.withSession(async (facts, loanSignal): Promise<MarkdownAttachmentProviderResult> =>
    {
        const signal = AbortSignal.any([controller.signal, loanSignal, item.signal, batch.signal]);
        signal.throwIfAborted();
        const provider = createArticleAttachmentUploadProvider({
            uploadId: facts.uploadId, uploadToken: facts.uploadToken,
            sha256: facts.sha256, totalBytes: facts.totalBytes,
            commitMayHaveStarted: facts.commitMayHaveStarted
        });
        const observed = await provider.observe(signal);
        signal.throwIfAborted();
        if (observed.status !== 'committed' || !observed.asset.assetId.trim()
            || observed.asset.publicUrl !== completion.url || !completion.borrow.isCurrent())
        {
            throw new Error('article-attachment-committed-facts-unavailable');
        }
        return Object.freeze({ status: 'resolved', batchId: batch.batchId, itemId: item.itemId,
            documentIdentity: batch.documentIdentity, revision: batch.revision,
            payload: Object.freeze({ markdownKind: item.kind === 'image' ? 'image' : 'file',
                href: observed.asset.publicUrl, assetId: observed.asset.assetId,
                mimeType: item.mimeType, name: item.name }) });
    });
    void result.then(() =>
    {
        // withSession fulfills only after the real callback work and its original scope cleanup.
        scopeCompleted = true;
        scopeFinished = true;
        reconsider();
    }, (cause: unknown) =>
    {
        // Rejection cannot distinguish callback failure from unconfirmed loan cleanup.
        scopeFinished = true;
        failures.push({ cause });
    });
    return Object.freeze({ result, settled,
        cancelLocal(reason?: string): void
        {
            cancellationPending = true;
            let failed = false;
            let firstCause: unknown;
            for (const operation of [() => controller.abort(reason), () => completion.borrow.release()])
            {
                try
                {
                    operation();
                }
                catch (cause)
                {
                    if (!failed)
                    {
                        firstCause = cause;
                        failed = true;
                    }
                    failures.push({ cause });
                }
            }
            if (failed)
            {
                throw firstCause;
            }
            cancellationPending = false;
            if (scopeFinished)
            {
                // The actual loan release retries original pending scope cleanup. Only after
                // callback work has ended may its successful retry confirm this provider scope.
                scopeCompleted = true;
            }
            reconsider();
        },
        inspectLocalResources(): never
        {
            // The existing transport provider exposes no authoritative complete numeric census.
            throw new Error('article-attachment-committed-facts-resources-unavailable');
        },
        inspectObservationFailures: () => Object.freeze(failures.map(failure => Object.freeze({ ...failure })))
    });
}
