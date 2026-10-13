import {
    decodeArticleInboxCaptureResponse,
    encodeArticleInboxCaptureRequest,
    matchesArticleInboxCaptureRequest,
    type ArticleInboxCaptureRequest,
    type ArticleInboxCaptureResponse
} from '@/codecs/binary/articleInboxCaptureWire.generated';
import { runPrivateRequest } from '@/services/privateRequestRuntime';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { decode } from '@wasm/aeds';
import { FrameType } from '@wasm/protocol/frame';

import { binaryRequest } from './binaryApiClient';
import { encodeAedsFrame } from './binaryFrame';

/** Actual typed private transport source; canonical generated bindings/registration remain held. */
export async function createInboxCapture(
    request: ArticleInboxCaptureRequest, signal?: AbortSignal
): Promise<ArticleInboxCaptureResponse>
{
    return await sendCapture(request, false, signal);
}

/** Null receipt remains an unobserved outcome; callers retain the original payload and UUID. */
export async function reconcileInboxCapture(
    request: ArticleInboxCaptureRequest, signal?: AbortSignal
): Promise<ArticleInboxCaptureResponse>
{
    return await sendCapture(request, true, signal);
}

async function sendCapture(request: ArticleInboxCaptureRequest, reconcile: boolean,
    signal?: AbortSignal): Promise<ArticleInboxCaptureResponse>
{
    // Freeze one input snapshot before encoding and the first await. Unknown members are rejected by the codec.
    const frozen = Object.freeze({ ...request });
    const payload = encodeArticleInboxCaptureRequest(frozen);
    const requestFrame = reconcile ? FrameType.ArticleInboxCaptureReconcileRequest : FrameType.ArticleInboxCaptureCreateRequest;
    const path = reconcile ? '/api/binary/author/articles/inbox/reconcile' : '/api/binary/author/articles/inbox';
    return await runPrivateRequest('admin', signal, async leaseSignal =>
    {
        const bytes = await binaryRequest(path, {
            method: 'POST', body: encodeAedsFrame(requestFrame, payload), requiresPow: true, signal: leaseSignal
        });
        leaseSignal.throwIfAborted();
        const frame = decode(bytes);
        if (!frame.ok || frame.frameType !== FrameType.ArticleInboxCaptureResponse)
            throw createAppError(AppErrorCode.ProtocolFailure, 'article_inbox_capture_frame_invalid');
        let response: ArticleInboxCaptureResponse;
        try
        {
            response = decodeArticleInboxCaptureResponse(frame.payloadView);
            if (!matchesArticleInboxCaptureRequest(frozen, response) || !reconcile && response.receipt === null)
                throw new RangeError('article_inbox_capture_correlation_invalid');
        }
        catch
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'article_inbox_capture_response_invalid');
        }
        leaseSignal.throwIfAborted();
        return Object.freeze({ ...response, receipt: response.receipt === null ? null : Object.freeze({ ...response.receipt }) });
    });
}
