import * as wire from '@/codecs/binary/authoringCanvasWire.generated';
import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes';
import { runPrivateRequest } from '@/services/privateRequestRuntime';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { decode } from '@wasm/aeds';
import { FrameType } from '@wasm/protocol/frame';

import { binaryRequest } from './binaryApiClient';
import { encodeAedsFrame } from './binaryFrame';
function canvasParams(canvasId: string): { canvasId: string; }
{
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(canvasId)
        || canvasId === '00000000-0000-0000-0000-000000000000')
    {
        throw new Error('canvas_id_invalid');
    }
    return { canvasId };
}
function pageQuery(limit: number, cursor: wire.AuthoringCanvasPageCursor | null)
{
    return { limit, cursorOrder: cursor?.order, cursorId: cursor?.id };
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
        return read(buildFsusBinaryRoute('binary_author_canvas_list', {}, pageQuery(100, cursor)), FrameType.AuthoringCanvasListResponse, wire.decodeAuthoringCanvasListResponse, signal);
    },
    header(canvasId: string, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_header', canvasParams(canvasId)), FrameType.AuthoringCanvasDocumentHeader, wire.decodeAuthoringCanvasDocumentHeader, signal);
    },
    nodes(canvasId: string, cursor: wire.AuthoringCanvasPageCursor | null = null, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_nodes', canvasParams(canvasId), pageQuery(256, cursor)), FrameType.AuthoringCanvasNodesResponse, wire.decodeAuthoringCanvasNodesResponse, signal);
    },
    edges(canvasId: string, cursor: wire.AuthoringCanvasPageCursor | null = null, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_edges', canvasParams(canvasId), pageQuery(256, cursor)), FrameType.AuthoringCanvasEdgesResponse, wire.decodeAuthoringCanvasEdgesResponse, signal);
    },
    history(canvasId: string, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_history', canvasParams(canvasId)), FrameType.AuthoringCanvasHistoryResponse, wire.decodeAuthoringCanvasHistoryResponse, signal);
    },
    create(request: wire.AuthoringCanvasCreateRequest, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_create'), FrameType.AuthoringCanvasDocumentHeader, wire.decodeAuthoringCanvasDocumentHeader, signal, { method: 'POST', frame: FrameType.AuthoringCanvasCreateRequest,
            payload: wire.encodeAuthoringCanvasCreateRequest(request) });
    },
    apply(canvasId: string, request: wire.AuthoringCanvasApplyRequest, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_apply', canvasParams(canvasId)), FrameType.AuthoringCanvasOperationReceipt, wire.decodeAuthoringCanvasOperationReceipt, signal, { method: 'POST',
            frame: FrameType.AuthoringCanvasApplyRequest, payload: wire.encodeAuthoringCanvasApplyRequest(request) });
    },
    prepare(canvasId: string, request: wire.AuthoringCanvasApplyRequest, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_prepare', canvasParams(canvasId)), FrameType.AuthoringCanvasApplyRequest, wire.decodeAuthoringCanvasApplyRequest, signal, { method: 'POST',
            frame: FrameType.AuthoringCanvasApplyRequest, payload: wire.encodeAuthoringCanvasApplyRequest(request) });
    },
    undoRedo(canvasId: string, request: wire.AuthoringCanvasUndoRedoRequest, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_history_apply', canvasParams(canvasId)), FrameType.AuthoringCanvasOperationReceipt, wire.decodeAuthoringCanvasOperationReceipt, signal, { method: 'POST',
            frame: FrameType.AuthoringCanvasUndoRedoRequest, payload: wire.encodeAuthoringCanvasUndoRedoRequest(request) });
    },
    delete(canvasId: string, request: wire.AuthoringCanvasDeleteRequest, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_delete', canvasParams(canvasId)), FrameType.AuthoringCanvasWriteReceipt, wire.decodeAuthoringCanvasWriteReceipt, signal, { method: 'DELETE', frame: FrameType.AuthoringCanvasDeleteRequest,
            payload: wire.encodeAuthoringCanvasDeleteRequest(request) });
    },
    resolve(canvasId: string, request: wire.AuthoringCanvasResolveRequest, signal?: AbortSignal)
    {
        return read(buildFsusBinaryRoute('binary_author_canvas_resolve', canvasParams(canvasId)), FrameType.AuthoringCanvasReferenceResolutionBatch, wire.decodeAuthoringCanvasReferenceResolutionBatch, signal, { method: 'POST',
            frame: FrameType.AuthoringCanvasResolveRequest, payload: wire.encodeAuthoringCanvasResolveRequest(request) });
    }
};
