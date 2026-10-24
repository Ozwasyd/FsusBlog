import type {
    ArticlePreviewResponse,
    ServerDraftSaveRequest
} from '@/api/authoring';

import type { Ref } from 'vue';

export type ArticlePreviewSourceSnapshot = Pick<
    ServerDraftSaveRequest,
  'title' | 'content' | 'summary' | 'coverImageUrl'
>;

interface ArticlePreviewGenerationOptions {
    target: Ref<ArticlePreviewResponse | null>;
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
        const request = options.readRequest();
        const requestSnapshot = snapshotPreviewSource(request);
        const expectedIdentity = await options.createIdentity(request);
        const preview = await options.requestPreview(request, signal);
        if (signal.aborted)
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
