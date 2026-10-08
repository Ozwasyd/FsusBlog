import { decodeAuthorArticleSelectionRevalidationResponse, encodeAuthorArticleSelectionRevalidationRequest, matchesAuthorArticleSelectionRequest, type AuthorArticleSelectionRevalidationRequest, type AuthorArticleSelectionRevalidationResponse } from '@/codecs/binary/authorArticleSelectionWire.generated';
import { runPrivateRequest } from '@/services/privateRequestRuntime';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { decode } from '@wasm/aeds';
import { FrameType } from '@wasm/protocol/frame';

import { binaryRequest } from './binaryApiClient';
import { encodeAedsFrame } from './binaryFrame';

/** Selected-ID freshness only; workspace intent and query ordering remain with their actual owners. */
export async function revalidateAuthorArticleSelection(
    request: AuthorArticleSelectionRevalidationRequest, signal?: AbortSignal
): Promise<AuthorArticleSelectionRevalidationResponse>
{
    // Encode before the first await and retain an immutable request for reply correlation.
    const payload = encodeAuthorArticleSelectionRevalidationRequest(request);
    const frozen = Object.freeze({ ...request });
    return await runPrivateRequest('admin', signal, async (leaseSignal) =>
    {
        const bytes = await binaryRequest('/api/binary/author/articles/revalidate-selection', {
            method: 'POST', body: encodeAedsFrame(FrameType.AuthorArticleSelectionRevalidateRequest, payload),
            requiresPow: true, signal: leaseSignal
        });
        leaseSignal.throwIfAborted();
        const frame = decode(bytes);
        if (!frame.ok || frame.frameType !== FrameType.AuthorArticleSelectionRevalidateResponse)
            throw createAppError(AppErrorCode.ProtocolFailure, 'author_article_selection_frame_invalid');
        let response: AuthorArticleSelectionRevalidationResponse;
        try
        {
            response = decodeAuthorArticleSelectionRevalidationResponse(frame.payloadView);
            if (!matchesAuthorArticleSelectionRequest(frozen, response)) throw new RangeError('selection_correlation');
        }
        catch
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'author_article_selection_response_invalid');
        }
        leaseSignal.throwIfAborted();
        return Object.freeze({ ...response, owner: Object.freeze({ ...response.owner }) });
    });
}
