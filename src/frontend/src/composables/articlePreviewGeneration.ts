import { getCurrentScope, onScopeDispose, shallowReadonly, shallowRef, type Ref } from 'vue';

import type {
    ArticlePreviewResponse,
    ServerDraftSaveRequest
} from '@/api/authoring';
import type { ArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import {
    isCurrentArticlePreviewAttachmentProjection,
    type ArticlePreviewAttachmentPort,
    type ArticlePreviewAttachmentProjection,
    type ArticlePreviewAttachmentState
} from '@/services/authoring/articlePreviewAttachments';
import type { ArticlePreviewSourceAdmission } from '@/services/authoring/articlePreviewSourceAdmission';

export type ArticlePreviewSourceSnapshot = Pick<
    ServerDraftSaveRequest,
  'title' | 'content' | 'summary' | 'coverImageUrl'
>;

export interface ArticlePreviewGenerationOptions<P extends ArticlePreviewAttachmentProjection> {
    target: Ref<ArticlePreviewResponse | null>;
    documentContext: Pick<ArticleDocumentContextAdapter, 'context' | 'isCurrentContext'>
        & Partial<Pick<ArticleDocumentContextAdapter, 'subscribeContext'>>;
    sourceAdmission?: () => ArticlePreviewSourceAdmission;
    /** Original business owner. Missing is explicit; source-only transport is never resource qualification. */
    attachmentBusiness?: () => ArticlePreviewAttachmentPort<P> | null;
    readRequest: () => ServerDraftSaveRequest;
    readCurrentSnapshot: () => ArticlePreviewSourceSnapshot;
    createIdentity: (request: ServerDraftSaveRequest) => Promise<string>;
    requestPreview: (
        request: ServerDraftSaveRequest,
        signal: AbortSignal
    ) => Promise<ArticlePreviewResponse>;
}

const snapshotPreviewSource = (
    request: ArticlePreviewSourceSnapshot
): ArticlePreviewSourceSnapshot => ({
    title: request.title,
    content: request.content,
    summary: request.summary,
    coverImageUrl: request.coverImageUrl
});

const canceled = Symbol('article-preview-canceled');
async function waitForPreviewWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof canceled>
{
    let abort: (() => void) | undefined;
    try
    {
        return await Promise.race([work, new Promise<typeof canceled>(resolve =>
        {
            abort = () => resolve(canceled);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted)
            {
                abort();
            }
        })]);
    }
    finally
    {
        if (abort)
        {
            signal.removeEventListener('abort', abort);
        }
    }
}

export function useArticlePreviewGeneration<P extends ArticlePreviewAttachmentProjection = ArticlePreviewAttachmentProjection>(
    options: ArticlePreviewGenerationOptions<P>
): {
    generate: (signal: AbortSignal) => Promise<ArticlePreviewResponse | null>;
    attachmentState: Readonly<Ref<ArticlePreviewAttachmentState<P>>>;
    dispose: () => void;
}
{
    let currentGeneration = 0;
    let disposed = false;
    let activeController: AbortController | null = null;
    const attachmentState = shallowRef<ArticlePreviewAttachmentState<P>>({
        status: 'missing', projection: null, reason: 'attachment-business-owner-missing'
    });
    const stopContextObserver = options.documentContext.subscribeContext?.(() =>
    {
        activeController?.abort('preview-context-changed');
        const projection = attachmentState.value.projection;
        if (projection && !options.documentContext.isCurrentContext(projection.context))
        {
            attachmentState.value = Object.freeze({ status: 'stale', projection: null, reason: 'preview-context-changed' });
        }
    }) ?? (() => undefined);
    const dispose = (): void =>
    {
        if (!disposed)
        {
            disposed = true;
            ++currentGeneration;
            activeController?.abort('preview-consumer-disposed');
            activeController = null;
            stopContextObserver();
            attachmentState.value = Object.freeze({ status: 'canceled', projection: null, reason: 'preview-consumer-disposed' });
        }
    };
    if (getCurrentScope())
    {
        onScopeDispose(dispose);
    }

    const generate = async (signal: AbortSignal): Promise<ArticlePreviewResponse | null> =>
    {
        if (disposed)
        {
            return null;
        }
        const requestGeneration = ++currentGeneration;
        activeController?.abort('preview-superseded');
        const controller = new AbortController();
        activeController = controller;
        const consumerSignal = AbortSignal.any([signal, controller.signal]);
        const requestContext = options.documentContext.context;
        let admission: ArticlePreviewSourceAdmission | undefined;
        const setAttachments = (status: ArticlePreviewAttachmentState<P>['status'],
            projection: P | null, reason: string | null): void =>
        {
            if (requestGeneration === currentGeneration)
            {
                attachmentState.value = Object.freeze({ status, projection, reason });
            }
        };
        const cancelAdmission = (): void => admission?.cancel();
        let requestSignal = consumerSignal;
        consumerSignal.addEventListener('abort', cancelAdmission, { once: true });
        try
        {
            setAttachments('missing', null, 'attachment-business-owner-missing');
            admission = options.sourceAdmission?.();
            const sourceRequest = admission?.begin();
            requestSignal = sourceRequest ? AbortSignal.any([consumerSignal, sourceRequest.signal]) : consumerSignal;
            const isCurrentRequest = (): boolean => !requestSignal.aborted
                && requestGeneration === currentGeneration
                && options.documentContext.isCurrentContext(requestContext);
            if (!isCurrentRequest())
            {
                setAttachments('canceled', null, 'preview-canceled');
                return null;
            }
            const business = options.attachmentBusiness?.();
            let attachments: P | null = null;
            if (options.attachmentBusiness)
            {
                if (!options.documentContext.subscribeContext)
                {
                    setAttachments('blocked', null, 'preview-context-observer-missing');
                    return null;
                }
                if (!business)
                {
                    setAttachments('blocked', null, 'attachment-business-owner-missing');
                    return null;
                }
                setAttachments('checking', null, null);
                const assessment = await waitForPreviewWork(business.assess(requestSignal), requestSignal);
                if (assessment === canceled || !isCurrentRequest())
                {
                    setAttachments('canceled', null, 'preview-canceled');
                    return null;
                }
                if (!isCurrentArticlePreviewAttachmentProjection(assessment, requestContext))
                {
                    setAttachments('blocked', null, 'attachment-projection-invalid');
                    return null;
                }
                attachments = assessment;
                if (attachments.blockingNodeIds.length > 0)
                {
                    setAttachments('blocked', attachments, 'attachment-business-blocked');
                    return null;
                }
                const verified = await waitForPreviewWork(business.verify(attachments, requestSignal), requestSignal);
                if (verified !== true || !isCurrentRequest())
                {
                    setAttachments(verified === canceled ? 'canceled' : 'stale', null, 'attachment-projection-not-current');
                    return null;
                }
            }
            const request = options.readRequest();
            const requestSnapshot = snapshotPreviewSource(request);
            const expectedIdentity = await waitForPreviewWork(options.createIdentity(request), requestSignal);
            if (expectedIdentity === canceled || !isCurrentRequest())
            {
                setAttachments('canceled', null, 'preview-canceled');
                return null;
            }
            const preview = await waitForPreviewWork(options.requestPreview(request, requestSignal), requestSignal);
            if (preview === canceled || !isCurrentRequest())
            {
                setAttachments('canceled', null, 'preview-canceled');
                return null;
            }
            if (business && attachments)
            {
                const verified = await waitForPreviewWork(business.verify(attachments, requestSignal), requestSignal);
                if (verified !== true || !isCurrentRequest())
                {
                    setAttachments(verified === canceled ? 'canceled' : 'stale', null, 'attachment-projection-not-current');
                    return null;
                }
            }
            if (sourceRequest && !admission!.accept(sourceRequest, preview).accepted)
            {
                setAttachments('stale', null, 'preview-input-changed');
                return null;
            }

            const committed = commitArticlePreviewIfCurrent({
                target: options.target,
                preview,
                expectedIdentity,
                requestGeneration,
                currentGeneration,
                requestSnapshot,
                currentSnapshot: snapshotPreviewSource(options.readCurrentSnapshot())
            });
            if (attachments)
            {
                setAttachments(committed ? 'ready' : 'stale', committed ? attachments : null,
                    committed ? null : 'preview-input-changed');
            }
            return committed ? preview : null;
        }
        catch (error)
        {
            setAttachments(requestSignal.aborted ? 'canceled' : 'failed', null, 'attachment-or-preview-failed');
            throw error;
        }
        finally
        {
            consumerSignal.removeEventListener('abort', cancelAdmission);
            admission?.dispose();
            if (activeController === controller)
            {
                activeController = null;
            }
        }
    };

    return { generate, attachmentState: shallowReadonly(attachmentState), dispose };
}

export function commitArticlePreviewIfCurrent(input: {
    target: Ref<ArticlePreviewResponse | null>;
    preview: ArticlePreviewResponse;
    expectedIdentity: string;
    requestGeneration: number;
    currentGeneration: number;
    requestSnapshot: ArticlePreviewSourceSnapshot;
    currentSnapshot: ArticlePreviewSourceSnapshot;
}): boolean
{
    if (input.requestGeneration !== input.currentGeneration)
    {
        return false;
    }
    const request = input.requestSnapshot;
    const current = input.currentSnapshot;
    if (request.title !== current.title
    || request.content !== current.content
    || (request.summary ?? '') !== (current.summary ?? '')
    || (request.coverImageUrl ?? '') !== (current.coverImageUrl ?? ''))
    {
        return false;
    }
    if (input.preview.sourceIdentity !== input.expectedIdentity)
    {
        throw new Error('article_preview_source_identity_mismatch');
    }
    input.target.value = input.preview;
    return true;
}
