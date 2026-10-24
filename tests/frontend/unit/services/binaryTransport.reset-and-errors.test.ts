import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as binaryApiClient from '@/api/binaryApiClient';
import { encodeAedsFrame, writeFixedUtf8 } from '@/api/binaryFrame';
import { decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry';
import { binaryDecodeWorkerProtocolVersion } from '@/contracts/binaryTransport';
import type { BinaryWorkerRequest, DecodeWorkerRequest, DecodeWorkerResponse } from '@/contracts/binaryTransport';
import { BinaryTransportError, createBinaryTransport } from '@/services/binaryTransport';
import { AppErrorCode } from '@/utils/appError';

import { decode, resolveAedsWorkerRuntimeModel } from '@wasm/aeds';
import type * as AedsModule from '@wasm/aeds';
import { FrameType } from '@wasm/protocol/frame';

// Keep the production envelope decoder and worker policy. Four logical processors
// select two active requests through the real policy, rather than a policy stub.
vi.mock('@wasm/aeds', async (importOriginal) =>
{
    const actual = await importOriginal<typeof AedsModule>();
    return {
        ...actual,
        resolveAedsWorkerRuntimeModel: () => actual.resolveAedsWorkerRuntimeModel(undefined, 4)
    };
});

// Vitest SSR resolves worker URL imports against file: module URLs. Supply the
// application's same-origin development asset URL; the real Trusted Types
// validator still checks its origin, development source path and fragment;
// this existing DEV branch permits the bundler query, unlike production assets.
vi.mock('@/workers/wasmDecode.worker.ts?worker&url', () => ({
    default: 'https://fsusblog.test/src/workers/wasmDecode.worker.ts?worker_file&type=module'
}));

// This controlled unit boundary emits real protocol messages; it does not execute
// wasmDecode.worker.ts or qualify browser Worker transfer/lifecycle behavior.
class ControlledDecodeWorker extends EventTarget
{
    static instances: ControlledDecodeWorker[] = [];
    readonly postMessage = vi.fn<(request: BinaryWorkerRequest, transfer?: Transferable[]) => void>();
    readonly terminate = vi.fn<() => void>();

    constructor(scriptUrl: string | URL, options: WorkerOptions)
    {
        super();
        expect(String(scriptUrl)).toBe('https://fsusblog.test/src/workers/wasmDecode.worker.ts?worker_file&type=module');
        expect(options).toEqual({ type: 'module' });
        ControlledDecodeWorker.instances.push(this);
    }

    fail(): void
    {
        this.dispatchEvent(Object.assign(new Event('error'), {
            error: new Error('controlled_decode_worker_failed'),
            message: 'controlled_decode_worker_failed'
        }));
    }

    complete(request: DecodeWorkerRequest): void
    {
        const frame = decode(request.buffer);
        expect(frame.ok).toBe(true);
        expect(frame.frameType).toBe(request.expectedFrameType);
        const response: DecodeWorkerResponse = {
            v: binaryDecodeWorkerProtocolVersion,
            requestId: request.requestId,
            ok: true,
            frameType: frame.frameType,
            data: decodeBinaryFramePayload(frame.frameType, frame.payloadView, request.accessProfile),
            errorCode: 'none'
        };
        this.dispatchEvent(new MessageEvent<DecodeWorkerResponse>('message', { data: response }));
    }

    decodeRequests(): DecodeWorkerRequest[]
    {
        return this.postMessage.mock.calls.map(([request]) => request)
            .filter((request): request is DecodeWorkerRequest => request.type !== 'cancel');
    }
}

function encodeLargePageContent(): ArrayBuffer
{
    const content = new TextEncoder().encode('# About\n\n' + 'worker decode content. '.repeat(256));
    const payload = new Uint8Array(140 + content.byteLength);
    const view = new DataView(payload.buffer);
    writeFixedUtf8(payload, 0, 128, 'about');
    view.setInt32(128, 0, true);
    view.setInt32(132, content.byteLength, true);
    view.setInt32(136, content.byteLength, true);
    payload.set(content, 140);
    return encodeAedsFrame(FrameType.PageContent, payload);
}

function encodeEmptyMessageApiError(): ArrayBuffer
{
    const payload = new Uint8Array(584);
    const view = new DataView(payload.buffer);
    payload[0] = 5;
    payload[1] = 3;
    view.setInt32(4, 428, true);
    writeFixedUtf8(payload, 264, 256, 'role_required');
    writeFixedUtf8(payload, 520, 64, 'trace-empty-message');
    return encodeAedsFrame(FrameType.ApiError, payload);
}

const transport = createBinaryTransport(decodeBinaryFramePayload);

beforeEach(() =>
{
    vi.useFakeTimers();
    ControlledDecodeWorker.instances = [];
    vi.stubGlobal('Worker', ControlledDecodeWorker);
    vi.spyOn(binaryApiClient, 'binaryRequest').mockRejectedValue(new Error('unexpected-real-fetch'));
});

afterEach(() =>
{
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('binaryTransport reset and error contracts', () =>
{
    it('rejects two active decodes and the queued decode once, cleans abort handlers, and accepts a later request', async () =>
    {
        expect(resolveAedsWorkerRuntimeModel().activeRequests).toBe(2);
        vi.mocked(binaryApiClient.binaryRequest).mockImplementation(() => Promise.resolve(encodeLargePageContent()));
        const controllers = Array.from({ length: 3 }, () => new AbortController());
        const removals = controllers.map((controller) => vi.spyOn(controller.signal, 'removeEventListener'));
        const observers = controllers.map(() => ({ resolved: vi.fn(), rejected: vi.fn() }));
        const settled = controllers.map((controller, index) => transport.requestBinaryOnly({
            binaryUrl: '/api/binary/system/page/about',
            frameType: FrameType.PageContent,
            signal: controller.signal
        }).then(observers[index].resolved, observers[index].rejected));

        await vi.waitFor(() =>
        {
            expect(binaryApiClient.binaryRequest).toHaveBeenCalledTimes(3);
            expect(observers[0].rejected.mock.calls).toEqual([]);
            expect(ControlledDecodeWorker.instances).toHaveLength(1);
            expect(ControlledDecodeWorker.instances[0].decodeRequests()).toHaveLength(2);
        });
        const worker = ControlledDecodeWorker.instances[0];
        const active = worker.decodeRequests();
        expect(active.every((request) => request.buffer.byteLength > 4096)).toBe(true);
        expect(active.map((request) => request.requestId)).toEqual([...new Set(active.map((request) => request.requestId))]);
        const removedBeforeReset = removals.map((removal) => removal.mock.calls.length);
        worker.fail();
        await Promise.all(settled);

        for (const [index, observer] of observers.entries())
        {
            expect(observer.resolved).not.toHaveBeenCalled();
            expect(observer.rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
                name: 'BinaryTransportError',
                kind: 'network',
                message: 'controlled_decode_worker_failed'
            }));
            expect(removals[index].mock.calls.length).toBeGreaterThan(removedBeforeReset[index]);
        }
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.decodeRequests()).toHaveLength(2);
        // Late responses and aborts must not revive queued work or settle twice.
        for (const request of active)
        {
            worker.complete(request);
        }
        for (const controller of controllers)
        {
            controller.abort();
        }
        await Promise.resolve();
        for (const observer of observers)
        {
            expect(observer.resolved).not.toHaveBeenCalled();
            expect(observer.rejected).toHaveBeenCalledOnce();
        }
        expect(worker.postMessage).toHaveBeenCalledTimes(2);

        const later = transport.requestBinaryOnly({
            binaryUrl: '/api/binary/system/page/about',
            frameType: FrameType.PageContent
        });
        await vi.waitFor(() => expect(ControlledDecodeWorker.instances).toHaveLength(2));
        const replacement = ControlledDecodeWorker.instances[1];
        expect(replacement.decodeRequests()).toHaveLength(1);
        replacement.complete(replacement.decodeRequests()[0]);
        await expect(later).resolves.toEqual({
            slug: 'about',
            content: '# About\n\n' + 'worker decode content. '.repeat(256)
        });
        // Reset the replacement too, so no singleton or idle timer leaks to another case.
        replacement.fail();
        expect(replacement.terminate).toHaveBeenCalledOnce();
    });

    it('uses the transport message for an empty ApiError message and preserves backend, trace, and risk metadata', async () =>
    {
        vi.mocked(binaryApiClient.binaryRequest).mockRejectedValue(new binaryApiClient.BinaryRequestError(
            428,
            'Binary request failed: 428',
            encodeEmptyMessageApiError(),
            undefined,
            { 'X-Fsus-Challenge-Proof-Outcome': 'expired', 'X-Fsus-Risk-Decision': 'stepUp' }
        ));
        await expect(transport.requestBinaryOnly({
            binaryUrl: '/api/binary/auth/recovery-key/verify',
            frameType: FrameType.RecoveryKeyVerifyResponse
        })).rejects.toMatchObject({
            name: 'BinaryTransportError',
            kind: 'precondition_required',
            code: AppErrorCode.PreconditionRequired,
            status: 428,
            message: 'Binary request failed: 428 [trace:trace-empty-message]',
            traceId: 'trace-empty-message',
            backendCode: 5,
            backendCategory: 3,
            details: 'role_required',
            riskChallengeFailure: 'expired',
            riskControlDecision: 'stepUp'
        });
    });

    it('preserves the exact normalized transport message when no ApiError frame exists', async () =>
    {
        vi.mocked(binaryApiClient.binaryRequest).mockRejectedValue(new binaryApiClient.BinaryRequestError(
            404, 'Binary request failed: 404', new ArrayBuffer(0)
        ));
        const result = transport.requestBinaryOnly({
            binaryUrl: '/api/binary/article/list/home/1/10.aeds',
            frameType: FrameType.ArticleList
        });
        await expect(result).rejects.toBeInstanceOf(BinaryTransportError);
        await expect(result).rejects.toMatchObject({
            kind: 'not_found',
            code: AppErrorCode.NotFound,
            status: 404,
            message: 'Binary request failed: 404'
        });
    });
});
