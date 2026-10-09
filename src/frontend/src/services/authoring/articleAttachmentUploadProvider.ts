import { abortUpload, completeUpload, getUploadStatus, readCommittedUploadPreview } from '@/api/upload';
import { readCommittedUploadFacts } from '@/api/uploadFacts';

/** Transport observations are not article-operation or reference grants. */
export interface AttachmentAssetFacts {
    readonly assetId: string;
    readonly publicUrl: string;
    readonly sha256: string;
    readonly assetVersionSha256: string;
    readonly referenceLedgerSha256: string;
    readonly sizeBytes: number;
}

export type AttachmentUploadObservation =
    | { readonly status: 'pending'; readonly uploadedBytes: number; readonly totalBytes: number; }
    | { readonly status: 'committed'; readonly asset: AttachmentAssetFacts; }
    | { readonly status: 'cancelled'; readonly reason: 'original-abort-acknowledged'; }
    | { readonly status: 'failed' | 'recovery-required'; readonly reason: string; };

export interface AttachmentUploadProvider {
    observe(signal?: AbortSignal): Promise<AttachmentUploadObservation>;
    retryCommit(signal?: AbortSignal): Promise<AttachmentUploadObservation>;
    cancel(signal?: AbortSignal): Promise<AttachmentUploadObservation>;
}

export interface OwnedAttachmentUploadSession {
    readonly uploadId: string;
    readonly uploadToken: string;
    readonly sha256: string;
    readonly totalBytes: number;
    /** Original provider's actual operation history; unknown history must use true. */
    readonly commitMayHaveStarted: boolean;
}

function assetFacts(facts: AttachmentAssetFacts): AttachmentAssetFacts
{
    return Object.freeze({
        assetId: facts.assetId,
        publicUrl: facts.publicUrl,
        sha256: facts.sha256,
        assetVersionSha256: facts.assetVersionSha256,
        referenceLedgerSha256: facts.referenceLedgerSha256,
        sizeBytes: facts.sizeBytes
    });
}

/** Wrap only an already-owned original upload session. No upload, intent or ledger store. */
export function createArticleAttachmentUploadProvider(session: OwnedAttachmentUploadSession): AttachmentUploadProvider
{
    if (!/^[a-f0-9]{32}$/u.test(session.uploadId) || !/^[a-f0-9]{64}$/u.test(session.sha256)
        || !session.uploadToken || !Number.isSafeInteger(session.totalBytes) || session.totalBytes <= 0
        || typeof session.commitMayHaveStarted !== 'boolean')
    {
        throw new Error('attachment_upload_session_invalid');
    }
    // Credentials stay in this closure, never in business receipts or persisted refs.
    const owned = Object.freeze({ ...session });
    let commitMayHaveStarted = owned.commitMayHaveStarted;
    let cancelled = false;
    let abortMayHaveStarted = false;
    let activeCommit: Promise<AttachmentUploadObservation> | null = null;
    let commitController: AbortController | null = null;

    async function observe(signal?: AbortSignal): Promise<AttachmentUploadObservation>
    {
        signal?.throwIfAborted();
        if (cancelled)
        {
            return { status: 'cancelled', reason: 'original-abort-acknowledged' };
        }
        try
        {
            const status = await getUploadStatus(owned.uploadId, signal, owned.uploadToken);
            signal?.throwIfAborted();
            if (status.uploadId !== owned.uploadId || status.totalBytes !== owned.totalBytes
                || !Number.isSafeInteger(status.uploadedBytes) || status.uploadedBytes < 0
                || status.uploadedBytes > status.totalBytes)
            {
                return { status: 'recovery-required', reason: 'upload_status_binding_invalid' };
            }
            if (status.status === 'completed')
            {
                commitMayHaveStarted = true;
                const committed = owned.totalBytes > 8_387_832
                    ? await readCommittedUploadFacts(owned.uploadId, owned.uploadToken, owned.sha256, signal)
                    : await readCommittedUploadPreview(owned.uploadId, owned.uploadToken, owned.sha256, signal);
                signal?.throwIfAborted();
                if (committed.sizeBytes !== owned.totalBytes)
                {
                    return { status: 'recovery-required', reason: 'upload_asset_size_mismatch' };
                }
                return { status: 'committed', asset: assetFacts(committed) };
            }
            if (!['pending', 'uploading', 'uploaded'].includes(status.status))
            {
                return { status: 'recovery-required', reason: 'upload_status_unknown' };
            }
            return { status: 'pending', uploadedBytes: status.uploadedBytes, totalBytes: status.totalBytes };
        }
        catch
        {
            signal?.throwIfAborted();
            // No invented pending progress after a failed read or expired session.
            return { status: 'recovery-required', reason: 'upload_observation_failed' };
        }
    }

    return Object.freeze({
        observe,
        async retryCommit(signal?: AbortSignal): Promise<AttachmentUploadObservation>
        {
            signal?.throwIfAborted();
            if (cancelled)
            {
                return { status: 'cancelled', reason: 'original-abort-acknowledged' };
            }
            if (abortMayHaveStarted)
            {
                return { status: 'recovery-required', reason: 'upload_abort_unknown' };
            }
            if (activeCommit)
            {
                // Retain the original task; cancellation belongs to this joining caller only.
                return await activeCommit.finally(() => signal?.throwIfAborted());
            }
            commitMayHaveStarted = true;
            const controller = new AbortController();
            const onAbort = (): void => controller.abort(signal?.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
            commitController = controller;
            const attempt = (async (): Promise<AttachmentUploadObservation> =>
            {
                try
                {
                    await completeUpload(owned.uploadId, owned.uploadToken, owned.sha256, controller.signal);
                    return await observe(controller.signal);
                }
                catch
                {
                    signal?.throwIfAborted();
                    // A failed RPC can follow server promotion; retain the original session.
                    return { status: 'recovery-required', reason: 'upload_commit_unknown' };
                }
            })();
            activeCommit = attempt;
            try
            {
                return await attempt;
            }
            finally
            {
                activeCommit = null;
                commitController = null;
                signal?.removeEventListener('abort', onAbort);
            }
        },
        async cancel(signal?: AbortSignal): Promise<AttachmentUploadObservation>
        {
            signal?.throwIfAborted();
            if (cancelled)
            {
                return { status: 'cancelled', reason: 'original-abort-acknowledged' };
            }
            commitController?.abort(new DOMException('Attachment cancelled', 'AbortError'));
            if (commitMayHaveStarted)
            {
                const current = await observe(signal);
                return current.status === 'committed' ? current
                    : { status: 'recovery-required', reason: 'abort_missing_atomic_commit_outcome' };
            }
            try
            {
                abortMayHaveStarted = true;
                const ack = await abortUpload(owned.uploadId, signal, owned.uploadToken);
                signal?.throwIfAborted();
                if (ack.uploadId !== owned.uploadId || ack.status !== 'aborted')
                {
                    return { status: 'recovery-required', reason: 'upload_abort_ack_invalid' };
                }
                cancelled = true;
                return { status: 'cancelled', reason: 'original-abort-acknowledged' };
            }
            catch
            {
                signal?.throwIfAborted();
                return { status: 'recovery-required', reason: 'upload_abort_unknown' };
            }
        }
    });
}
