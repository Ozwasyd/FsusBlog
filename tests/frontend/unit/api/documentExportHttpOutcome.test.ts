import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { BinaryRequestError } from '@/api/binaryApiClient';
import { captureDocumentExportRequest, classifyDocumentExportFailure, requestDocumentExport } from '@/api/documentExport';
import { decodeDocumentExportRequest } from '@/codecs/binary/documentExportWire.generated';
import { createDocumentExportCall } from '@/components/document-export/documentExportCall';
import { BinaryTransportError } from '@/composition/binaryTransport';
import { privateRequestRuntime, StalePrivateResponseError } from '@/services/privateRequestRuntime';

import goldens from '../../../backend/Fixtures/document-export-payload-goldens-v1.json';

const http = vi.hoisted(() => vi.fn());
// Only the outer HTTP boundary is controlled. Use the actual composition,
// transport normalization, Shared request codec and transient command.
vi.mock('@/api/binaryApiClient', async () => ({
    ...(await vi.importActual<typeof import('@/api/binaryApiClient')>('@/api/binaryApiClient')),
    binaryRequest: http
}));
function request() {
    const hex = goldens.vectors.find(vector => vector.name === 'request-revision')!.hex;
    return decodeDocumentExportRequest(Uint8Array.from(hex.match(/../gu)!, value => Number.parseInt(value, 16)));
}
async function actualFailure(status: number): Promise<unknown> {
    http.mockRejectedValue(new BinaryRequestError(status, 'private response details', new ArrayBuffer(0)));
    try { await requestDocumentExport(request()); } catch (error) { return error; }
    throw new Error('expected_original_http_failure');
}
beforeEach(() => { privateRequestRuntime.resetForTests(); http.mockReset(); });
afterEach(() => { privateRequestRuntime.resetForTests(); });

it.each([500, 502, 503, 504])('preserves uncertainty for actual normalized HTTP %s without a successful job', async status => {
    const failure = await actualFailure(status);
    expect(failure).toBeInstanceOf(BinaryTransportError);
    expect(failure).toMatchObject({ status, kind: status === 503 ? 'public_artifact_not_ready' : 'network' });
    expect(classifyDocumentExportFailure(failure)).toBe('uncertain');
    expect(http).toHaveBeenCalledOnce();
});
it.each([400, 405, 406, 409, 422, 428, 429])('retains definite actual HTTP %s refusal despite transport kind', async status => {
    const failure = await actualFailure(status);
    expect(failure).toBeInstanceOf(BinaryTransportError);
    expect(failure).toMatchObject({ status });
    expect(classifyDocumentExportFailure(failure)).toBe('rejected');
    expect(http).toHaveBeenCalledOnce();
});
it.each([401, 403, 404])('retains privacy-safe actual HTTP %s permission/source denial', async status => {
    const failure = await actualFailure(status);
    expect(classifyDocumentExportFailure(failure)).toBe('permission-revoked');
    expect(http).toHaveBeenCalledOnce();
});
it('holds a real normalized 503 and explicitly replays only the exact captured request', async () => {
    http.mockRejectedValue(new BinaryRequestError(503, 'private response details', new ArrayBuffer(0)));
    const changed = vi.fn(); const permissionRevoked = vi.fn();
    const call = createDocumentExportCall({ captureRequest: captureDocumentExportRequest, execute: requestDocumentExport,
        classifyFailure: classifyDocumentExportFailure, changed, permissionRevoked, allowUncertainRetry: true });
    const original = request(); const expected = captureDocumentExportRequest(original);
    await call.start(original);
    expect(changed).toHaveBeenLastCalledWith({ phase: 'uncertain' });
    expect(http).toHaveBeenCalledOnce(); // No automatic retry.
    original.requestId = 'fresh-request'; original.idempotencyKey = 'fresh-key'; original.source.sourceVersion = '18';
    await call.start(original);
    expect(http).toHaveBeenCalledOnce(); // Unknown write prevents fresh admission.
    await call.retry();
    expect(http).toHaveBeenCalledTimes(2);
    const first = http.mock.calls[0]!; const second = http.mock.calls[1]!;
    expect(first[0]).toBe('/api/binary/document-export/request'); expect(second[0]).toBe(first[0]);
    expect(second[1].body).toEqual(first[1].body);
    expect(decodeDocumentExportRequest(new Uint8Array(second[1].body, 16))).toEqual(expected);
    expect(second[1]).toMatchObject({ method: 'POST', credentials: 'include', requiresPow: true });
    expect(changed).toHaveBeenLastCalledWith({ phase: 'uncertain' });
    expect(permissionRevoked).not.toHaveBeenCalled();
    expect(JSON.stringify(changed.mock.calls)).not.toContain('private response details');
});
it.each([401, 403, 404])('clears admission after actual HTTP %s and prevents replay or fresh admission', async status => {
    http.mockRejectedValue(new BinaryRequestError(status, 'private response details', new ArrayBuffer(0)));
    const changed = vi.fn(); const permissionRevoked = vi.fn();
    const call = createDocumentExportCall({ captureRequest: captureDocumentExportRequest, execute: requestDocumentExport,
        classifyFailure: classifyDocumentExportFailure, changed, permissionRevoked, allowUncertainRetry: true });
    await call.start(request()); await call.retry(); await call.start({ ...request(), idempotencyKey: 'fresh-key' });
    expect(changed).toHaveBeenLastCalledWith({ phase: 'permission-revoked' });
    expect(permissionRevoked).toHaveBeenCalledOnce(); expect(http).toHaveBeenCalledOnce();
    expect(JSON.stringify(changed.mock.calls)).not.toContain('private response details');
});
it('keeps missing-status network/decode uncertainty separate from local and explicit refusal', () => {
    for (const kind of ['network', 'decode_failed'] as const) {
        expect(classifyDocumentExportFailure(new BinaryTransportError({ kind, message: 'unconfirmed' }))).toBe('uncertain');
    }
    for (const kind of ['validation', 'conflict', 'precondition_required', 'rate_limited', 'public_artifact_not_ready'] as const) {
        expect(classifyDocumentExportFailure(new BinaryTransportError({ kind, message: 'refused' }))).toBe('rejected');
    }
    expect(classifyDocumentExportFailure(new RangeError())).toBe('rejected');
    expect(classifyDocumentExportFailure(new StalePrivateResponseError('admin'))).toBe('permission-revoked');
    expect(classifyDocumentExportFailure(new BinaryTransportError({ kind: 'decode_failed', status: 200, message: 'unconfirmed' }))).toBe('uncertain');
});
