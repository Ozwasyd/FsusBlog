import * as wire from '@/codecs/binary/authoringCanvasWire.generated';
import { runPrivateRequest } from '@/services/privateRequestRuntime';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { decode } from '@wasm/aeds';
import { FrameType } from '@wasm/protocol/frame';

import { binaryRequest } from './binaryApiClient';
import { encodeAedsFrame } from './binaryFrame';
const ROOT = '/api/binary/author/canvases';
function path(canvasId: string): string
{
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canvasId)
        || canvasId === '00000000-0000-0000-0000-000000000000')
    {
        throw new Error('canvas_id_invalid');
    }
    return `${ROOT}/${encodeURIComponent(canvasId)}`;
}
function pageQuery(limit: number, cursor: wire.AuthoringCanvasPageCursor | null): string
{
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor)
    {
        query.set('cursorOrder', cursor.order);
        query.set('cursorId', cursor.id);
    }
    return `?${query.toString()}`;
}
async function read<T>(url: string, frameType: FrameType, reader: (payload: Uint8Array) => T, signal?: AbortSignal, mutation?: {
    method: 'POST' | 'DELETE';
    frame: FrameType;
    payload: Uint8Array;
}): Promise<T>
{
    return await runPrivateRequest('admin', signal, async (leaseSignal) =>
    {
        const buffer = await binaryRequest(url, mutation ? {
            method: mutation.method, body: encodeAedsFrame(mutation.frame, mutation.payload), requiresPow: true, signal: leaseSignal
        } : { signal: leaseSignal });
        leaseSignal.throwIfAborted();
        const frame = decode(buffer);
        if (!frame.ok || frame.frameType !== frameType)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'canvas_aeds_frame_invalid');
        }
        try
        {
            return reader(frame.payloadView);
        }
        catch
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'canvas_aeds_payload_invalid');
        }
    });
}
/** All authority comes from the authenticated binary boundary; mutation inputs omit owner and actor. */
export const authoringCanvasApi = {
    list(cursor: wire.AuthoringCanvasPageCursor | null = null, signal?: AbortSignal)
    {
        return read(ROOT + pageQuery(100, cursor), FrameType.AuthoringCanvasListResponse, wire.decodeAuthoringCanvasListResponse, signal);
    },
    header(canvasId: string, signal?: AbortSignal)
    {
        return read(path(canvasId), FrameType.AuthoringCanvasDocumentHeader, wire.decodeAuthoringCanvasDocumentHeader, signal);
    },
    nodes(canvasId: string, cursor: wire.AuthoringCanvasPageCursor | null = null, signal?: AbortSignal)
    {
        return read(path(canvasId) + '/nodes' + pageQuery(256, cursor), FrameType.AuthoringCanvasNodesResponse, wire.decodeAuthoringCanvasNodesResponse, signal);
    },
    edges(canvasId: string, cursor: wire.AuthoringCanvasPageCursor | null = null, signal?: AbortSignal)
    {
        return read(path(canvasId) + '/edges' + pageQuery(256, cursor), FrameType.AuthoringCanvasEdgesResponse, wire.decodeAuthoringCanvasEdgesResponse, signal);
    },
    history(canvasId: string, signal?: AbortSignal)
    {
        return read(path(canvasId) + '/history', FrameType.AuthoringCanvasHistoryResponse, wire.decodeAuthoringCanvasHistoryResponse, signal);
    },
    create(request: wire.AuthoringCanvasCreateRequest, signal?: AbortSignal)
    {
        return read(ROOT, FrameType.AuthoringCanvasDocumentHeader, wire.decodeAuthoringCanvasDocumentHeader, signal, { method: 'POST', frame: FrameType.AuthoringCanvasCreateRequest,
            payload: wire.encodeAuthoringCanvasCreateRequest(request) });
    },
    apply(canvasId: string, request: wire.AuthoringCanvasApplyRequest, signal?: AbortSignal)
    {
        return read(path(canvasId) + '/operations', FrameType.AuthoringCanvasOperationReceipt, wire.decodeAuthoringCanvasOperationReceipt, signal, { method: 'POST',
            frame: FrameType.AuthoringCanvasApplyRequest, payload: wire.encodeAuthoringCanvasApplyRequest(request) });
    },
    prepare(canvasId: string, request: wire.AuthoringCanvasApplyRequest, signal?: AbortSignal)
    {
        return read(path(canvasId) + '/prepare', FrameType.AuthoringCanvasApplyRequest, wire.decodeAuthoringCanvasApplyRequest, signal, { method: 'POST',
            frame: FrameType.AuthoringCanvasApplyRequest, payload: wire.encodeAuthoringCanvasApplyRequest(request) });
    },
    undoRedo(canvasId: string, request: wire.AuthoringCanvasUndoRedoRequest, signal?: AbortSignal)
    {
        return read(path(canvasId) + '/history', FrameType.AuthoringCanvasOperationReceipt, wire.decodeAuthoringCanvasOperationReceipt, signal, { method: 'POST',
            frame: FrameType.AuthoringCanvasUndoRedoRequest, payload: wire.encodeAuthoringCanvasUndoRedoRequest(request) });
    },
    delete(canvasId: string, request: wire.AuthoringCanvasDeleteRequest, signal?: AbortSignal)
    {
        return read(path(canvasId), FrameType.AuthoringCanvasWriteReceipt, wire.decodeAuthoringCanvasWriteReceipt, signal, { method: 'DELETE', frame: FrameType.AuthoringCanvasDeleteRequest,
            payload: wire.encodeAuthoringCanvasDeleteRequest(request) });
    },
    resolve(canvasId: string, request: wire.AuthoringCanvasResolveRequest, signal?: AbortSignal)
    {
        return read(path(canvasId) + '/resolve', FrameType.AuthoringCanvasReferenceResolutionBatch, wire.decodeAuthoringCanvasReferenceResolutionBatch, signal, { method: 'POST',
            frame: FrameType.AuthoringCanvasResolveRequest, payload: wire.encodeAuthoringCanvasResolveRequest(request) });
    }
};
