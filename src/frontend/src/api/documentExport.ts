import { binaryRequest, BinaryRequestError } from '@/api/binaryApiClient';
import { encodeAedsFrame } from '@/api/binaryFrame';
import { encodeDocumentExportRequest, encodeDocumentExportTaskRequest } from '@/codecs/binary/documentExportWire.generated';
import type { DocumentExportJobResponse, DocumentExportPageResponse, DocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import type { DocumentExportCallFailure } from '@/components/document-export/documentExportCall';
import { requestBinaryOnly, BinaryTransportError } from '@/composition/binaryTransport';
import { privateRequestRuntime, StalePrivateResponseError } from '@/services/privateRequestRuntime';

import { FrameType } from '@wasm/protocol/frame';

class DocumentExportConsumerError extends Error
{
    constructor()
    {
        super('document_export_consumer_invalid');
    }
}

class DocumentExportUnconfirmedResponseError extends Error
{
    constructor()
    {
        super('document_export_response_unconfirmed');
    }
}

/** Only the original delivery owner may save bytes; it must honor the signal up to the save boundary. */
export interface DocumentExportPrivateDelivery {
    bytes: ArrayBuffer;
    filename: string;
    mediaType: string;
}

export type DocumentExportPrivateDeliver = (delivery: Readonly<DocumentExportPrivateDelivery>, signal: AbortSignal) => Promise<void>;

function frame(name: string): FrameType
{
    const value = (FrameType as Readonly<Record<string, FrameType | undefined>>)[name];
    if (value === undefined || !Number.isInteger(value))
    {
        throw new DocumentExportConsumerError();
    }
    return value;
}

/** Capture the actual admission identity; neither allocate jobs nor normalize source coordinates. */
export function captureDocumentExportRequest(request: DocumentExportRequest): DocumentExportRequest
{
    const captured = Object.freeze({ ...request, source: Object.freeze({ ...request.source }) });
    // The sole generated encoder owns canonical Int64 and all byte/grammar rules.
    encodeDocumentExportRequest(captured);
    return captured;
}

export function documentExportSameSource(left: DocumentExportRequest['source'], right: DocumentExportRequest['source']): boolean
{
    return left.kind === right.kind && left.articleId === right.articleId && left.draftKey === right.draftKey
        && left.revisionId === right.revisionId && left.publicationId === right.publicationId
        && left.sourceVersion === right.sourceVersion;
}

function taskBody(taskId: string): ArrayBuffer
{
    return encodeAedsFrame(frame('DocumentExportTaskRequest'), encodeDocumentExportTaskRequest({ taskId }));
}

async function task(action: 'status' | 'cancel' | 'retry' | 'delete', taskId: string, signal?: AbortSignal): Promise<DocumentExportJobResponse>
{
    const result = await requestBinaryOnly<DocumentExportJobResponse>({
        binaryUrl: `/api/binary/document-export/${action}`,
        frameType: frame('DocumentExportJobResponse'),
        privateScope: 'admin',
        requestOptions: { method: 'POST', credentials: 'include', body: taskBody(taskId), requiresPow: action !== 'status' },
        signal
    });
    if (result.taskId !== taskId)
    {
        throw new DocumentExportUnconfirmedResponseError();
    }
    return result;
}

export async function requestDocumentExport(request: DocumentExportRequest, signal?: AbortSignal): Promise<DocumentExportJobResponse>
{
    const captured = captureDocumentExportRequest(request);
    const result = await requestBinaryOnly<DocumentExportJobResponse>({
        binaryUrl: '/api/binary/document-export/request',
        frameType: frame('DocumentExportJobResponse'),
        privateScope: 'admin',
        requestOptions: {
            method: 'POST', credentials: 'include', requiresPow: true,
            body: encodeAedsFrame(frame('DocumentExportRequest'), encodeDocumentExportRequest(captured))
        },
        signal
    });
    if (result.requestId !== captured.requestId || !documentExportSameSource(result.source, captured.source)
        || result.formatId !== captured.formatId || result.layoutProfile !== captured.layoutProfile
        || result.themeProfile !== captured.themeProfile || result.locale !== captured.locale)
    {
        throw new DocumentExportUnconfirmedResponseError();
    }
    return result;
}

export async function listDocumentExports(offset: number, limit: number, signal?: AbortSignal): Promise<DocumentExportPageResponse>
{
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647
        || !Number.isInteger(limit) || limit < 1 || limit > 50)
    {
        throw new DocumentExportConsumerError();
    }
    const page = await requestBinaryOnly<DocumentExportPageResponse>({
        binaryUrl: `/api/binary/document-export/tasks?offset=${offset}&limit=${limit}`,
        frameType: frame('DocumentExportPageResponse'), privateScope: 'admin',
        requestOptions: { method: 'GET', credentials: 'include' }, signal
    });
    if (page.offset !== offset || page.limit !== limit)
    {
        throw new DocumentExportUnconfirmedResponseError();
    }
    return page;
}

export const getDocumentExport = (taskId: string, signal?: AbortSignal): Promise<DocumentExportJobResponse> => task('status', taskId, signal);
export const cancelDocumentExport = (taskId: string, signal?: AbortSignal): Promise<DocumentExportJobResponse> => task('cancel', taskId, signal);
export const retryDocumentExport = (taskId: string, signal?: AbortSignal): Promise<DocumentExportJobResponse> => task('retry', taskId, signal);
export const deleteDocumentExport = (taskId: string, signal?: AbortSignal): Promise<DocumentExportJobResponse> => task('delete', taskId, signal);

/** Consume only the actual private response; no grant, path or URL is returned to the UI. */
export async function downloadDocumentExport(taskId: string, signal: AbortSignal, deliver: DocumentExportPrivateDeliver): Promise<void>
{
    const body = taskBody(taskId);
    const lease = privateRequestRuntime.open('admin', signal);
    try
    {
        let headers: Headers | undefined;
        const bytes = await binaryRequest('/api/binary/document-export/download', {
            method: 'POST', credentials: 'include', requiresPow: true, body, signal: lease.signal,
            onResponseHeaders: value =>
            {
                headers = value;
            }
        });
        lease.assertCurrent();
        lease.signal!.throwIfAborted();
        const length = headers?.get('content-length');
        const disposition = headers?.get('content-disposition');
        const match = disposition?.match(/^attachment; filename="([a-zA-Z0-9][a-zA-Z0-9._ -]{0,127})"$/u);
        const mediaType = headers?.get('content-type');
        if (!length || BigInt(bytes.byteLength).toString() !== length
            || !match || match[0] !== disposition || match[1] === '.' || match[1] === '..'
            || !mediaType || headers?.get('cache-control') !== 'no-store'
            || headers.get('x-content-type-options') !== 'nosniff' || headers.get('accept-ranges') !== 'none')
        {
            throw new DocumentExportConsumerError();
        }
        lease.assertCurrent();
        lease.signal!.throwIfAborted();
        await deliver(Object.freeze({ bytes, filename: match[1], mediaType }), lease.signal!);
        lease.assertCurrent();
        lease.signal!.throwIfAborted();
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

export function classifyDocumentExportFailure(error: unknown): DocumentExportCallFailure
{
    if (error instanceof DocumentExportUnconfirmedResponseError)
    {
        return 'uncertain';
    }
    if (error instanceof StalePrivateResponseError)
    {
        return 'permission-revoked';
    }
    if (error instanceof BinaryTransportError)
    {
        if (['auth_failed', 'forbidden', 'not_found'].includes(error.kind))
        {
            return 'permission-revoked';
        }
        return ['network', 'decode_failed'].includes(error.kind) ? 'uncertain' : 'rejected';
    }
    if (error instanceof BinaryRequestError)
    {
        return [401, 403, 404].includes(error.status) ? 'permission-revoked'
            : error.status >= 500 ? 'uncertain' : 'rejected';
    }
    return error instanceof DocumentExportConsumerError || error instanceof RangeError ? 'rejected' : 'uncertain';
}
