import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry';
import {
    binaryDecodeWorkerProtocolVersion,
    type BinaryWorkerRequest,
    type DecodeErrorCode,
    type DecodeWorkerResponse,
    type DecodeWorkerTerminal
} from '@/contracts/binaryTransport';
import { AppErrorCode, isAppError } from '@/utils/appError';

import { decode, getAedsRuntimeDiagnostics, initWasm } from '@wasm/aeds';

export const DECODE_WORKER_PROTOCOL_VERSION = binaryDecodeWorkerProtocolVersion;

const canceledRequests = new Set<number>();
const activeRequests = new Map<number, DecodeWorkerResponse | null>();
let wasmReadyPromise: Promise<boolean> | null = null;

const exactDecodeErrorMap: Record<string, DecodeErrorCode> = {
    frame_too_short: 'payload_out_of_range',
    magic_mismatch: 'schema_mismatch',
    version_mismatch: 'schema_mismatch',
    payload_length_mismatch: 'payload_out_of_range',
    oom: 'decode_failed',
    payload_ptr_invalid: 'payload_out_of_range',
    payload_invalid: 'payload_out_of_range',
    payload_too_short: 'payload_out_of_range',
    invalid_input: 'schema_mismatch'
};

const payloadRangePrefixes = [
    'article_list_',
    'comment_',
    'stats_',
    'article_hot_'
] as const;

function classifyDecodeErrorId(errorId: string): DecodeErrorCode
{
    const exact = exactDecodeErrorMap[errorId];
    if (exact)
    {
        return exact;
    }

    if (
        payloadRangePrefixes.some((prefix) => errorId.startsWith(prefix))
    || errorId.startsWith('search_index_')
    || errorId.startsWith('search_patch_')
    )
    {
        return 'payload_out_of_range';
    }

    return 'pod_parse_failed';
}

function classifyError(error: unknown): DecodeErrorCode
{
    if (isAppError(error))
    {
        switch (error.code)
        {
            case AppErrorCode.ProtocolFailure:
                return 'schema_mismatch';
            case AppErrorCode.InvariantViolation:
            case AppErrorCode.InfraFailure:
            case AppErrorCode.Unknown:
            default:
                return 'pod_parse_failed';
        }
    }

    if (error instanceof Error)
    {
        return classifyDecodeErrorId(error.message || 'pod_parse_failed');
    }

    if (typeof error === 'string' && error.length > 0)
    {
        return classifyDecodeErrorId(error);
    }

    return 'pod_parse_failed';
}

function ensureWasmReady(): Promise<boolean>
{
    if (!wasmReadyPromise)
    {
        wasmReadyPromise = initWasm();
    }

    return wasmReadyPromise;
}

function isRequestCanceled(requestId: number): boolean
{
    return canceledRequests.has(requestId);
}

function postDecodeResponse(response: DecodeWorkerResponse): void
{
    activeRequests.set(response.requestId, response.ok ? null : response);
    if (!isRequestCanceled(response.requestId))
    {
        self.postMessage(response);
    }
}

self.onmessage = async (event: MessageEvent<BinaryWorkerRequest>) =>
{
    const { v, requestId } = event.data;
    if (event.data.type === 'cancel')
    {
        // A late cancel must not leave an unbounded tombstone after the decode ended.
        if (v === DECODE_WORKER_PROTOCOL_VERSION && activeRequests.has(requestId))
        {
            canceledRequests.add(requestId);
        }
        return;
    }
    activeRequests.set(requestId, null);
    try
    {
        if (v !== DECODE_WORKER_PROTOCOL_VERSION)
        {
            const response: DecodeWorkerResponse = {
                v: DECODE_WORKER_PROTOCOL_VERSION,
                requestId,
                ok: false,
                errorCode: 'schema_mismatch',
                error: 'worker_protocol_version_mismatch'
            };
            postDecodeResponse(response);
            return;
        }

        const { buffer, expectedFrameType, sentAtUnixMs, accessProfile } = event.data;
        const workerTransferMs = typeof sentAtUnixMs === 'number' && Number.isFinite(sentAtUnixMs)
            ? Math.max(0, Date.now() - sentAtUnixMs)
            : undefined;
        if (isRequestCanceled(requestId))
        {
            return;
        }

        // Best-effort wasm init. When artifacts are missing, decode() already falls
        // back to decodeAedsEnvelopeNoCopy (CRC-checked JS envelope), matching the
        // main-thread path. Hard-failing here left >4KiB authoring JSON responses
        // (e.g. AuthorDraftResponse) as wasm_init_failed despite HTTP 200.
        await ensureWasmReady();
        if (isRequestCanceled(requestId))
        {
            return;
        }

        const frame = decode(buffer);
        if (isRequestCanceled(requestId))
        {
            return;
        }

        if (!frame.ok)
        {
            const response: DecodeWorkerResponse = {
                v: binaryDecodeWorkerProtocolVersion,
                requestId,
                ok: false,
                frameType: frame.frameType,
                errorCode: classifyError(frame.error ?? 'decode_failed'),
                error: frame.error ?? 'decode_failed',
                workerTransferMs,
                diagnostics: getAedsRuntimeDiagnostics()
            };
            postDecodeResponse(response);
            return;
        }

        if (expectedFrameType !== undefined && frame.frameType !== expectedFrameType)
        {
            const response: DecodeWorkerResponse = {
                v: binaryDecodeWorkerProtocolVersion,
                requestId,
                ok: false,
                frameType: frame.frameType,
                errorCode: 'frame_type_unexpected',
                error: 'frame_type_unexpected',
                workerTransferMs,
                diagnostics: getAedsRuntimeDiagnostics()
            };
            postDecodeResponse(response);
            return;
        }

        const data = decodeBinaryFramePayload(frame.frameType, frame.payloadView, accessProfile);
        if (isRequestCanceled(requestId))
        {
            return;
        }

        const response: DecodeWorkerResponse = {
            v: binaryDecodeWorkerProtocolVersion,
            requestId,
            ok: true,
            frameType: frame.frameType,
            data,
            errorCode: 'none',
            workerTransferMs,
            diagnostics: getAedsRuntimeDiagnostics()
        };
        postDecodeResponse(response);
    }
    catch (error)
    {
        const message = error instanceof Error ? error.message : 'pod_parse_failed';
        const response: DecodeWorkerResponse = {
            v: binaryDecodeWorkerProtocolVersion,
            requestId,
            ok: false,
            errorCode: message === 'wasm_init_failed' ? 'wasm_init_failed' : classifyError(error),
            error: message
        };
        postDecodeResponse(response);
    }
    finally
    {
        const failure = activeRequests.get(requestId);
        const canceled = canceledRequests.delete(requestId);
        activeRequests.delete(requestId);
        // No frame, decoded data, token or access profile crosses the cancellation terminal.
        const terminal: DecodeWorkerTerminal = {
            v: DECODE_WORKER_PROTOCOL_VERSION,
            type: 'terminal',
            requestId,
            outcome: failure ? 'failed' : canceled ? 'canceled' : 'completed',
            errorCode: failure?.errorCode,
            error: failure?.error
        };
        self.postMessage(terminal);
    }
};

export {};
