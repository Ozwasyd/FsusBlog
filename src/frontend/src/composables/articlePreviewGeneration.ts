import type {
    ArticlePreviewResponse,
    ServerDraftSaveRequest
} from '@/api/authoring';
import type { ArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import type { ArticlePreviewSourceAdmission } from '@/services/authoring/articlePreviewSourceAdmission';

import type { Ref } from 'vue';

export type ArticlePreviewSourceSnapshot = Pick<
    ServerDraftSaveRequest,
  'title' | 'content' | 'summary' | 'coverImageUrl'
>;

interface ArticlePreviewGenerationOptions {
    target: Ref<ArticlePreviewResponse | null>;
    documentContext: Pick<ArticleDocumentContextAdapter, 'context' | 'isCurrentContext'>;
    sourceAdmission?: () => ArticlePreviewSourceAdmission;
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

export function useArticlePreviewGeneration(
    options: ArticlePreviewGenerationOptions
): {
    generate: (signal: AbortSignal) => Promise<ArticlePreviewResponse | null>;
}
{
    let currentGeneration = 0;

    const generate = async (signal: AbortSignal): Promise<ArticlePreviewResponse | null> =>
    {
        const requestGeneration = ++currentGeneration;
        const requestContext = options.documentContext.context;
        const admission = options.sourceAdmission?.();
        const cancelAdmission = (): void => admission?.cancel();
        signal.addEventListener('abort', cancelAdmission, { once: true });
        try
        {
            const sourceRequest = admission?.begin();
            const requestSignal = sourceRequest ? AbortSignal.any([signal, sourceRequest.signal]) : signal;
            const isCurrentRequest = (): boolean => !requestSignal.aborted
                && requestGeneration === currentGeneration
                && options.documentContext.isCurrentContext(requestContext);
            if (!isCurrentRequest())
            {
                return null;
            }
            const request = options.readRequest();
            const requestSnapshot = snapshotPreviewSource(request);
            const expectedIdentity = await waitForPreviewWork(options.createIdentity(request), requestSignal);
            if (expectedIdentity === canceled || !isCurrentRequest())
            {
                return null;
            }
            const preview = await waitForPreviewWork(options.requestPreview(request, requestSignal), requestSignal);
            if (preview === canceled || !isCurrentRequest() || (sourceRequest && !admission!.accept(sourceRequest, preview).accepted))
            {
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
            return committed ? preview : null;
        }
        finally
        {
            signal.removeEventListener('abort', cancelAdmission);
            admission?.dispose();
        }
    };

    return { generate };
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
