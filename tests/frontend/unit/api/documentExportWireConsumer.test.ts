import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    cancelDocumentExport, captureDocumentExportRequest, classifyDocumentExportFailure, deleteDocumentExport,
    downloadDocumentExport, getDocumentExport, listDocumentExports, requestDocumentExport, retryDocumentExport
} from '@/api/documentExport';
import { BinaryRequestError } from '@/api/binaryApiClient';
import {
    decodeDocumentExportJobResponse, decodeDocumentExportRequest, decodeDocumentExportTaskRequest,
    encodeDocumentExportJobResponse
} from '@/codecs/binary/documentExportWire.generated';
import type { DocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { BinaryTransportError } from '@/composition/binaryTransport';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { createDocumentExportCall } from '@/components/document-export/documentExportCall';

import spec from '../../../../src/shared/Contracts/Validation/document-export-wire.json';
import goldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';

const transport = vi.hoisted(() => ({ binary: vi.fn(), raw: vi.fn() }));
vi.mock('@/composition/binaryTransport', async () => ({
    requestBinaryOnly: transport.binary,
    BinaryTransportError: (await vi.importActual<typeof import('@/services/binaryTransport')>('@/services/binaryTransport')).BinaryTransportError
}));
vi.mock('@/api/binaryApiClient', async () => ({
    ...(await vi.importActual<typeof import('@/api/binaryApiClient')>('@/api/binaryApiClient')),
    binaryRequest: transport.raw
}));
// Controlled transport binding reads the sole owner's literal contract. This is
// not an assertion that the current generic/native registries are activated.
vi.mock('@wasm/protocol/frame', async () => {
    const actual = await vi.importActual<typeof import('@wasm/protocol/frame')>('@wasm/protocol/frame');
    const owner = (await import('../../../../src/shared/Contracts/Validation/document-export-wire.json')).default;
    return { ...actual, FrameType: { ...actual.FrameType, ...Object.fromEntries(Object.entries(owner.roots).map(([name, root]) => [name, root.value])) } };
});

function payload(name: string): Uint8Array {
    const hex = goldens.vectors.find(vector => vector.name === name)!.hex;
    return Uint8Array.from(hex.match(/../gu)!, value => Number.parseInt(value, 16));
}
const queued = () => decodeDocumentExportJobResponse(payload('queued-job-response'));
const request = (): DocumentExportRequest => decodeDocumentExportRequest(payload('request-revision'));
beforeEach(() => { transport.binary.mockReset(); transport.raw.mockReset(); privateRequestRuntime.resetForTests(); });
afterEach(() => { privateRequestRuntime.resetForTests(); });

describe('typed export consumer with sole generated payloads', () => {
    it('preserves the original literal queued payload without a successful receipt', () => {
        expect(encodeDocumentExportJobResponse(queued())).toEqual(payload('queued-job-response'));
        expect(queued().output).toBeNull();
    });
    it('sends the captured request in the original frame with admin/PoW controls', async () => {
        transport.binary.mockResolvedValue(queued());
        const captured = captureDocumentExportRequest(request());
        await expect(requestDocumentExport(captured)).resolves.toEqual(queued());
        const sent = transport.binary.mock.calls[0]![0];
        const frame = new DataView(sent.requestOptions.body);
        expect(sent).toMatchObject({ privateScope: 'admin', frameType: spec.roots.DocumentExportJobResponse.value });
        expect(sent.requestOptions).toMatchObject({ method: 'POST', credentials: 'include', requiresPow: true });
        expect(frame.getUint16(8, true)).toBe(spec.roots.DocumentExportRequest.value);
        expect(decodeDocumentExportRequest(new Uint8Array(sent.requestOptions.body, 16))).toEqual(captured);
    });
    it('deep captures source/idempotency before caller mutation and preserves maximum Int64', () => {
        const original = request(); original.source.articleId = '9223372036854775807';
        const captured = captureDocumentExportRequest(original);
        original.source.articleId = '1'; original.idempotencyKey = 'changed';
        expect(captured.source.articleId).toBe('9223372036854775807');
        expect(captured.idempotencyKey).toBe('key-1');
        expect(Object.isFrozen(captured.source)).toBe(true);
    });
    it.each(['1\n', '1\r', '1\u2028', '01', '9223372036854775808'])('refuses noncanonical/overflow coordinate %s before HTTP', async value => {
        const intent = request(); intent.source.sourceVersion = value;
        await expect(requestDocumentExport(intent)).rejects.toThrow();
        expect(transport.binary).not.toHaveBeenCalled();
    });
    it('refuses changed response admission identity rather than adopting another job', async () => {
        transport.binary.mockResolvedValue({ ...queued(), requestId: 'different' });
        let failure: unknown;
        try { await requestDocumentExport(request()); } catch (error) { failure = error; }
        expect(String(failure)).toContain('document_export_response_unconfirmed');
        expect(classifyDocumentExportFailure(failure)).toBe('uncertain');
    });
    it.each([
        ['status', getDocumentExport, false], ['cancel', cancelDocumentExport, true],
        ['retry', retryDocumentExport, true], ['delete', deleteDocumentExport, true]
    ] as const)('uses typed task frame and original guards for %s', async (action, call, requiresPow) => {
        transport.binary.mockResolvedValue(queued());
        const controller = new AbortController();
        await call('task-1', controller.signal);
        const sent = transport.binary.mock.calls[0]![0];
        expect(sent).toMatchObject({ binaryUrl: `/api/binary/document-export/${action}`, privateScope: 'admin', signal: controller.signal });
        expect(sent.requestOptions.requiresPow).toBe(requiresPow);
        expect(new DataView(sent.requestOptions.body).getUint16(8, true)).toBe(spec.roots.DocumentExportTaskRequest.value);
        expect(decodeDocumentExportTaskRequest(new Uint8Array(sent.requestOptions.body, 16))).toEqual({ taskId: 'task-1' });
    });
    it('refuses a task response for another identity', async () => {
        transport.binary.mockResolvedValue({ ...queued(), taskId: 'other' });
        await expect(cancelDocumentExport('task-1')).rejects.toThrow();
    });
    it('keeps a sent admission uncertain and retries the same identity after a mismatched response', async () => {
        transport.binary.mockResolvedValue({ ...queued(), requestId: 'different' });
        const changed = vi.fn();
        const call = createDocumentExportCall({ captureRequest: captureDocumentExportRequest, execute: requestDocumentExport,
            classifyFailure: classifyDocumentExportFailure, changed, permissionRevoked: vi.fn(), allowUncertainRetry: true });
        await call.start(request());
        expect(changed).toHaveBeenLastCalledWith({ phase: 'uncertain' });
        await call.start({ ...request(), idempotencyKey: 'new-identity' });
        expect(transport.binary).toHaveBeenCalledTimes(1);
        await call.retry();
        expect(transport.binary).toHaveBeenCalledTimes(2);
        expect(transport.binary.mock.calls[1]![0].requestOptions.body).toEqual(transport.binary.mock.calls[0]![0].requestOptions.body);
    });
    it('requires actual page coordinates and bounded paging', async () => {
        transport.binary.mockResolvedValue({ offset: 20, limit: 20, hasMore: false, jobs: [queued()] });
        await expect(listDocumentExports(20, 20)).resolves.toMatchObject({ offset: 20 });
        await expect(listDocumentExports(0, 20)).rejects.toThrow();
        transport.binary.mockClear();
        await expect(listDocumentExports(2147483648, 20)).rejects.toThrow();
        await expect(listDocumentExports(0, 51)).rejects.toThrow();
        expect(transport.binary).not.toHaveBeenCalled();
    });
    it('keeps transport uncertainty distinct from privacy-safe denial and definite refusal', () => {
        expect(classifyDocumentExportFailure(new BinaryTransportError({ kind: 'not_found', message: 'private' }))).toBe('permission-revoked');
        expect(classifyDocumentExportFailure(new BinaryTransportError({ kind: 'network', message: 'lost' }))).toBe('uncertain');
        expect(classifyDocumentExportFailure(new BinaryTransportError({ kind: 'decode_failed', message: 'lost' }))).toBe('uncertain');
        expect(classifyDocumentExportFailure(new BinaryTransportError({ kind: 'conflict', message: 'no' }))).toBe('rejected');
        expect(classifyDocumentExportFailure(new BinaryRequestError(404, 'private', new ArrayBuffer(0)))).toBe('permission-revoked');
        expect(classifyDocumentExportFailure(new BinaryRequestError(503, 'unavailable', new ArrayBuffer(0)))).toBe('uncertain');
    });
});

const headers = () => new Headers({ 'content-length': '3', 'content-type': 'application/pdf',
    'content-disposition': 'attachment; filename="export.pdf"', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'accept-ranges': 'none' });
describe('controlled raw private delivery boundary, no real grant/output qualification', () => {
    it('delivers only actual bytes and safe response metadata with the private lease signal', async () => {
        const bytes = Uint8Array.of(1, 2, 3).buffer;
        transport.raw.mockImplementation(async (_url, options) => { options.onResponseHeaders(headers()); return bytes; });
        const deliver = vi.fn().mockResolvedValue(undefined);
        await downloadDocumentExport('task-1', new AbortController().signal, deliver);
        expect(deliver).toHaveBeenCalledWith({ bytes, filename: 'export.pdf', mediaType: 'application/pdf' }, expect.any(AbortSignal));
        expect(transport.raw.mock.calls[0]![1]).toMatchObject({ credentials: 'include', requiresPow: true, method: 'POST' });
    });
    it('performs zero saves after caller cancellation even when raw transport returns late', async () => {
        const controller = new AbortController();
        transport.raw.mockImplementation(async (_url, options) => { options.onResponseHeaders(headers()); controller.abort(); return new ArrayBuffer(3); });
        const deliver = vi.fn();
        await expect(downloadDocumentExport('task-1', controller.signal, deliver)).rejects.toThrow();
        expect(deliver).not.toHaveBeenCalled();
    });
    it('performs zero saves and reports revocation after admin identity changes', async () => {
        transport.raw.mockImplementation(async (_url, options) => { options.onResponseHeaders(headers()); privateRequestRuntime.advance('admin'); return new ArrayBuffer(3); });
        const deliver = vi.fn();
        let failure: unknown;
        try { await downloadDocumentExport('task-1', new AbortController().signal, deliver); } catch (error) { failure = error; }
        expect(classifyDocumentExportFailure(failure)).toBe('permission-revoked');
        expect(deliver).not.toHaveBeenCalled();
    });
    it.each(['content-length', 'cache-control', 'x-content-type-options', 'accept-ranges', 'content-disposition'])('requires actual %s before any save', async key => {
        const unsafe = headers(); unsafe.delete(key);
        transport.raw.mockImplementation(async (_url, options) => { options.onResponseHeaders(unsafe); return new ArrayBuffer(3); });
        const deliver = vi.fn();
        await expect(downloadDocumentExport('task-1', new AbortController().signal, deliver)).rejects.toThrow();
        expect(deliver).not.toHaveBeenCalled();
    });
    it('refuses unsafe filename and length mismatch without exposing or saving bytes', async () => {
        const unsafe = headers(); unsafe.set('content-disposition', 'attachment; filename="../private.pdf"');
        transport.raw.mockImplementation(async (_url, options) => { options.onResponseHeaders(unsafe); return new ArrayBuffer(4); });
        const deliver = vi.fn();
        await expect(downloadDocumentExport('task-1', new AbortController().signal, deliver)).rejects.toThrow();
        expect(deliver).not.toHaveBeenCalled();
    });
});
