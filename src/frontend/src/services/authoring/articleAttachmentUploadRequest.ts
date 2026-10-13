import { bindMarkdownAttachmentConsumerRequest } from '@ozwasyd/element-plus';

import type { ImageCompressionOptions } from '@/api/upload';
import type { ImageUploadFileCompletion } from '@/composables/useImageUploadFlow';
import type {
    ImageUploadAttemptBinding,
    ImageUploadLocalRequest,
    ImageUploadLocalResourceCensus,
    ImageUploadRuntimeOptions,
    useImageUploadRuntime
} from '@/composables/useImageUploadRuntime';

import type {
    MarkdownAttachmentBatchIntent,
    MarkdownAttachmentConsumerRequest,
    MarkdownAttachmentConsumerRequestBinding,
    MarkdownAttachmentConsumerResources,
    MarkdownAttachmentItemIntent,
    MarkdownAttachmentProviderResult
} from '@ozwasyd/element-plus';

/** Main supplies its actual admitted File and private pending lease, never a copied job. */
export interface ArticleAttachmentUploadRequestInput {
    readonly runtime: ReturnType<typeof useImageUploadRuntime>;
    readonly file: File;
    readonly batch: MarkdownAttachmentBatchIntent;
    readonly item: MarkdownAttachmentItemIntent;
    readonly attemptBinding: ImageUploadAttemptBinding;
    readonly options: ImageCompressionOptions;
    readonly runtimeOptions?: Pick<ImageUploadRuntimeOptions, 'wasmOnly' | 'bypassCompression' | 'targetFormat'>;
    /**
     * Start this provider's own work inside the ACK loan. Its result, settled and cancel cleanup
     * must not await enclosing upload/adapter futures or dependent native committed application,
     * directly or through async/then chains. Direct identity checks do not establish indirect safety.
     */
    requestProviderResult(completion: ImageUploadFileCompletion): MarkdownAttachmentConsumerRequest;
}

/** Original handles remain available when the UI's numeric resource interface is unsupported. */
export interface ArticleAttachmentUploadRequest extends MarkdownAttachmentConsumerRequest {
    readonly upload: ImageUploadLocalRequest<string>;
    getProviderRequest(): MarkdownAttachmentConsumerRequest | null;
    inspectUploadResources(): ImageUploadLocalResourceCensus;
    inspectObservationFailures(): readonly Readonly<{ cause: unknown; }>[];
}

/** The real upload ledger cannot attest the UI's network/memory totals, even after content result. */
export class ArticleAttachmentUploadResourcesUnavailable extends Error
{
    readonly upload: ImageUploadLocalResourceCensus;

    constructor(upload: ImageUploadLocalResourceCensus)
    {
        super('attachment_upload_numeric_resources_unavailable');
        this.name = 'ArticleAttachmentUploadResourcesUnavailable';
        this.upload = upload;
    }
}

/** Compose one actual upload with its ACK-time provider; Main/native/Doc application stays separate. */
export function requestArticleAttachmentUpload(input: ArticleAttachmentUploadRequestInput): ArticleAttachmentUploadRequest
{
    const { runtime, file, batch, item, attemptBinding, options } = input;
    const requestProviderResult = input.requestProviderResult.bind(input);
    const { intent, lease } = attemptBinding;
    const attachmentOwner = attemptBinding.owner;
    batch.signal.throwIfAborted();
    item.signal.throwIfAborted();
    intent.signal.throwIfAborted();
    lease.signal.throwIfAborted();
    // This is the actual accepted Main method. Older owners cannot grant native File custody.
    if (!('matchesCapturedFile' in attachmentOwner))
    {
        throw new Error('attachment_upload_native_file_owner_unavailable');
    }
    const matchesCapturedFile = attachmentOwner.matchesCapturedFile;
    if (typeof matchesCapturedFile !== 'function'
        || Reflect.apply(matchesCapturedFile, attachmentOwner, [intent, file]) !== true)
    {
        throw new Error('attachment_upload_original_file_unavailable');
    }
    const envelope = lease.envelope;
    if (batch.items[item.order] !== item || file.name !== item.name || file.type !== item.mimeType
        || file.size !== item.byteLength || intent.snapshot.task !== envelope
        || intent.request.requestId !== envelope.requestId
        || intent.request.batchId !== batch.batchId || intent.request.itemId !== item.itemId
        || intent.request.documentIdentity.id !== batch.documentIdentity.id
        || intent.request.documentIdentity.epoch !== batch.documentIdentity.epoch
        || !lease.isCurrent())
    {
        throw new Error('attachment_upload_original_binding_unavailable');
    }

    let providerRequest: MarkdownAttachmentConsumerRequest | null = null;
    let providerBinding: MarkdownAttachmentConsumerRequestBinding | null = null;
    let providerRequested = false;
    let providerAcquisitionClosed = false;
    let providerSettled = false;
    let uploadSettled = false;
    let observationFailed = false;
    let cancellationRequested = false;
    let cancellationReason: string | undefined;
    let providerResult: MarkdownAttachmentProviderResult | undefined;
    let fullSettled = false;
    let executionFinished = false;
    const failures: { cause: unknown; }[] = [];
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) =>
    {
        resolveSettled = resolve;
    });

    const reconsider = (): void =>
    {
        if (!executionFinished || !uploadSettled || !providerAcquisitionClosed || (providerRequested && !providerSettled)
            || observationFailed || fullSettled)
        {
            return;
        }
        try
        {
            if (providerBinding?.inspectCleanup().some(cleanup => cleanup.status !== 'fulfilled'))
            {
                return;
            }
            fullSettled = true;
            resolveSettled();
        }
        catch (cause)
        {
            observationFailed = true;
            failures.push({ cause });
        }
    };

    const observe = (future: PromiseLike<void>, completed: () => void): void =>
    {
        void Promise.resolve(future).then(() =>
        {
            completed();
            reconsider();
        }, (cause: unknown) =>
        {
            // A rejected full-settlement observation is not a stopped producer.
            observationFailed = true;
            failures.push({ cause });
        });
    };

    const cancelProvider = (): void =>
    {
        const binding = providerBinding;
        if (!binding)
        {
            return;
        }
        const work = binding.cancelLocal(cancellationReason);
        // Keep historical raw rejection even when a successful retry replaces the UI cleanup slot.
        void Promise.resolve(work).then(reconsider, (cause: unknown) =>
        {
            failures.push({ cause });
            // History is not live cleanup debt; actual successful retry can still settle.
            reconsider();
        });
    };

    const upload = runtime.requestUploadFile(file, options, {
        ...input.runtimeOptions,
        signal: item.signal,
        attemptBinding,
        onSessionReady: async (borrow, url) =>
        {
            await borrow.withSession(async (_session, signal) =>
            {
                signal.throwIfAborted();
                providerRequested = true;
                // Keep the returned original request before inspecting its capabilities.
                providerRequest = requestProviderResult(Object.freeze({ file, intent, borrow, url }));
                const bound = bindMarkdownAttachmentConsumerRequest(providerRequest);
                if (!bound.supported)
                {
                    throw new Error(bound.reason);
                }
                providerBinding = bound.value;
                const upstream = new Set<object>([upload.result, upload.settled, settled, result]);
                if (upstream.has(providerBinding.result) || upstream.has(providerBinding.settled))
                {
                    throw new Error('attachment_upload_consumer_self_wait');
                }
                providerAcquisitionClosed = true;
                observe(providerBinding.settled, () => providerSettled = true);
                if (cancellationRequested)
                {
                    cancelProvider();
                }
                const value = await providerBinding.result;
                signal.throwIfAborted();
                if (value.batchId !== batch.batchId || (value.itemId !== undefined && value.itemId !== item.itemId)
                    || (value.documentIdentity !== undefined && (value.documentIdentity.id !== batch.documentIdentity.id
                        || value.documentIdentity.epoch !== batch.documentIdentity.epoch))
                    || (value.revision !== undefined && value.revision !== batch.revision))
                {
                    throw new Error('attachment_upload_provider_result_binding_invalid');
                }
                if (value.status === 'resolved' && (!value.payload.assetId?.trim() || value.payload.href !== url))
                {
                    // The ACK URL never substitutes for a genuine AssetId or provider acceptance.
                    throw new Error('attachment_upload_asset_result_unavailable');
                }
                if (!borrow.isCurrent() || !lease.isCurrent())
                {
                    throw new Error('attachment_upload_provider_scope_revoked');
                }
                providerResult = value;
            });
        }
    });
    observe(upload.settled, () => uploadSettled = true);
    const result = (async (): Promise<MarkdownAttachmentProviderResult> =>
    {
        try
        {
            await upload.result;
            if (!providerResult)
            {
                throw new Error('attachment_upload_provider_result_unavailable');
            }
            return providerResult;
        }
        finally
        {
            executionFinished = true;
            if (!providerRequested)
            {
                // The actual upload ended without ever calling the provider factory.
                providerAcquisitionClosed = true;
            }
            reconsider();
        }
    })();

    const cancelLocal = (reason?: string): void =>
    {
        if (fullSettled)
        {
            return;
        }
        if (!cancellationRequested)
        {
            cancellationRequested = true;
            cancellationReason = reason;
        }
        let failed = false;
        let failure: unknown;
        for (const cancel of [() => upload.cancelLocal(cancellationReason), cancelProvider])
        {
            try
            {
                cancel();
            }
            catch (cause)
            {
                if (!failed)
                {
                    failed = true;
                    failure = cause;
                }
                failures.push({ cause });
            }
        }
        reconsider();
        if (failed)
        {
            throw failure;
        }
    };

    return Object.freeze({ result, settled, upload, cancelLocal,
        getProviderRequest: () => providerRequest,
        inspectUploadResources: () => upload.inspectLocalResources(),
        inspectObservationFailures: () => Object.freeze(failures.map(failure => Object.freeze({ ...failure }))),
        inspectLocalResources: (): MarkdownAttachmentConsumerResources =>
        {
            // Unsupported totals stay unsupported; no counting unknown network work as zero.
            throw new ArticleAttachmentUploadResourcesUnavailable(upload.inspectLocalResources());
        } });
}
