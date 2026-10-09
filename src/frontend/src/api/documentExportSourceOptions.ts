import { encodeAedsFrame } from '@/api/binaryFrame';
import { classifyDocumentExportFailure } from '@/api/documentExport';
import {
    encodeDocumentExportRevisionChoicesRequest, encodeDocumentExportSourceCaptureRequest
} from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import type {
    DocumentExportRevisionChoicesRequest, DocumentExportSourceCaptureRequest, DocumentExportSourceChoicesResponse,
    DocumentExportSourceCoordinate, DocumentExportSourceSelector
} from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import type { DocumentExportCallFailure } from '@/components/document-export/documentExportCall';
import {
    captureDocumentExportRevisionChoicesRequest, captureDocumentExportSourceCaptureRequest, captureDocumentExportSourceChoicesResponse
} from '@/components/document-export/documentExportSourceChoices';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import { BinaryTransportError } from '@/services/binaryTransport';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

import { FrameType } from '@wasm/protocol/frame';

class DocumentExportSourceChoicesUnconfirmedError extends Error
{
    constructor()
    {
        super('document_export_source_choices_unconfirmed');
    }
}

function matchesSelector(coordinate: DocumentExportSourceCoordinate, selector: DocumentExportSourceSelector): boolean
{
    return coordinate.kind === selector.kind && coordinate.articleId === selector.articleId.toString()
        && coordinate.draftKey === selector.draftKey && coordinate.revisionId === selector.revisionId
        && coordinate.publicationId === selector.publicationId;
}

async function capture(
    binaryUrl: string, body: ArrayBuffer,
    matches: (response: DocumentExportSourceChoicesResponse) => boolean,
    signal?: AbortSignal
): Promise<DocumentExportSourceChoicesResponse>
{
    const lease = privateRequestRuntime.open('admin', signal);
    try
    {
        lease.signal!.throwIfAborted();
        const response = await requestBinaryOnly<DocumentExportSourceChoicesResponse>({
            binaryUrl, frameType: FrameType.DocumentExportSourceChoicesResponse, privateScope: 'admin',
            requestOptions: {
                method: 'POST', credentials: 'include', requiresPow: true, cache: 'no-store', body,
                onResponseHeaders: () =>
                {
                    lease.assertCurrent();
                    lease.signal!.throwIfAborted();
                }
            }, signal: lease.signal
        });
        lease.assertCurrent();
        lease.signal!.throwIfAborted();
        let captured: DocumentExportSourceChoicesResponse;
        try
        {
            captured = captureDocumentExportSourceChoicesResponse(response);
        }
        catch
        {
            // The binding write may have committed; an invalid reply cannot confirm it.
            throw new DocumentExportSourceChoicesUnconfirmedError();
        }
        if (!matches(captured))
        {
            throw new DocumentExportSourceChoicesUnconfirmedError();
        }
        return captured;
    }
    catch (error)
    {
        lease.assertCurrent();
        throw error;
    }
    finally
    {
        lease.release();
    }
}

/** Original ArticleWrite/PoW POST persists bindings; never a GET or automatic retry. */
export async function captureDocumentExportSources(request: DocumentExportSourceCaptureRequest, signal?: AbortSignal): Promise<DocumentExportSourceChoicesResponse>
{
    const captured = captureDocumentExportSourceCaptureRequest(request);
    const body = encodeAedsFrame(FrameType.DocumentExportSourceCaptureRequest, encodeDocumentExportSourceCaptureRequest(captured));
    return capture('/api/binary/document-export/sources/capture', body, response =>
        response.choices.length === captured.sources.length
        && captured.sources.every(selector => response.choices.some(choice => matchesSelector(choice.coordinate, selector))), signal);
}

/** The actual catalog returns only this article's freshly authorized revision bindings. */
export async function captureDocumentExportRevisionChoices(request: DocumentExportRevisionChoicesRequest, signal?: AbortSignal): Promise<DocumentExportSourceChoicesResponse>
{
    const captured = captureDocumentExportRevisionChoicesRequest(request);
    const body = encodeAedsFrame(FrameType.DocumentExportRevisionChoicesRequest, encodeDocumentExportRevisionChoicesRequest(captured));
    return capture('/api/binary/document-export/sources/revisions', body, response =>
        response.choices.every(choice => choice.coordinate.kind === 2
            && choice.coordinate.articleId === captured.articleId.toString()), signal);
}

export function classifyDocumentExportSourceOptionsFailure(error: unknown): DocumentExportCallFailure
{
    if (error instanceof DocumentExportSourceChoicesUnconfirmedError)
    {
        return 'uncertain';
    }
    const failure = classifyDocumentExportFailure(error);
    // A normalized 5xx response cannot prove that the binding write did not commit.
    return failure !== 'permission-revoked' && error instanceof BinaryTransportError && (error.status ?? 0) >= 500
        ? 'uncertain' : failure;
}
