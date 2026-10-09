import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureDocumentExportRevisionChoices, captureDocumentExportSources, classifyDocumentExportSourceOptionsFailure } from '@/api/documentExportSourceOptions';
import {
    decodeDocumentExportRevisionChoicesRequest, decodeDocumentExportSourceCaptureRequest, decodeDocumentExportSourceChoicesResponse
} from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import { createDocumentExportCall } from '@/components/document-export/documentExportCall';
import { captureDocumentExportSourceCaptureRequest } from '@/components/document-export/documentExportSourceChoices';
import { binaryFrameDecoderRegistrations, binaryFrameDecoderRegistry, decodeBinaryFramePayload } from '@/composition/binaryDecoderRegistry';
import { BinaryTransportError } from '@/services/binaryTransport';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { FrameType } from '@wasm/protocol/frame';

import goldens from '../../../backend/Fixtures/document-export-source-options-payload-goldens-v1.json';
const transport = vi.hoisted(() => vi.fn());
vi.mock('@/composition/binaryTransport', async () => ({
    requestBinaryOnly: transport,
    BinaryTransportError: (await vi.importActual<typeof import('@/services/binaryTransport')>('@/services/binaryTransport')).BinaryTransportError
}));
// Only the outer HTTP/admission boundary is controlled. Frame roots, registry and
// codecs are actual owners; no successful job/output/receipt is constructed.
function payload(name: string): Uint8Array {
    return Uint8Array.from(goldens.vectors.find(vector => vector.name === name)!.hex.match(/../gu)!, value => Number.parseInt(value, 16));
}
const request = () => decodeDocumentExportSourceCaptureRequest(payload('capture-revision'));
const reply = () => decodeDocumentExportSourceChoicesResponse(payload('exact-version-choices'));
beforeEach(() => {
    privateRequestRuntime.resetForTests();
    transport.mockReset().mockImplementation(async options => {
        options.requestOptions.onResponseHeaders(new Headers({ 'cache-control': 'no-store' }));
        return decodeBinaryFramePayload(options.frameType, payload('exact-version-choices'));
    });
});
afterEach(() => { privateRequestRuntime.resetForTests(); });

it('uses only the actual registered response and preserves literal independent version facts', () => {
    expect(binaryFrameDecoderRegistrations.filter(([type]) => type === FrameType.DocumentExportSourceChoicesResponse)).toHaveLength(1);
    expect(binaryFrameDecoderRegistry[FrameType.DocumentExportSourceChoicesResponse]).toBe(decodeDocumentExportSourceChoicesResponse);
    expect(binaryFrameDecoderRegistry[FrameType.DocumentExportSourceCaptureRequest]).toBeUndefined();
    expect(binaryFrameDecoderRegistry[FrameType.DocumentExportRevisionChoicesRequest]).toBeUndefined();
    expect(reply().choices[0]!.coordinate.sourceVersion).toBe('9007199254740993');
});
it.each([
    ['capture', () => captureDocumentExportSources(request()), FrameType.DocumentExportSourceCaptureRequest, '/api/binary/document-export/sources/capture'],
    ['revisions', () => captureDocumentExportRevisionChoices({ articleId: 42 }), FrameType.DocumentExportRevisionChoicesRequest, '/api/binary/document-export/sources/revisions']
] as const)('calls the actual published %s POST with original admin/PoW/cancellation controls', async (_name, call, root, url) => {
    const result = await call(); const sent = transport.mock.calls[0]![0];
    expect(sent).toMatchObject({ binaryUrl: url, privateScope: 'admin', frameType: FrameType.DocumentExportSourceChoicesResponse });
    expect(sent.requestOptions).toMatchObject({ method: 'POST', credentials: 'include', requiresPow: true, cache: 'no-store' });
    expect(sent.signal).toBeInstanceOf(AbortSignal); expect(new DataView(sent.requestOptions.body).getUint16(8, true)).toBe(root);
    const bytes = new Uint8Array(sent.requestOptions.body, 16);
    if (root === FrameType.DocumentExportSourceCaptureRequest) expect(decodeDocumentExportSourceCaptureRequest(bytes)).toEqual(request());
    else expect(decodeDocumentExportRevisionChoicesRequest(bytes)).toEqual({ articleId: 42 });
    expect(result).toEqual(reply()); expect(Object.isFrozen(result.choices[0]!.coordinate)).toBe(true);
    expect(Object.keys(result)).toEqual(['choices']); expect(result).not.toHaveProperty('formats'); expect(result).not.toHaveProperty('private'); expect(result).not.toHaveProperty('locale');
});
it('captures original selectors before caller mutation instead of allocating a version or retry identity', async () => {
    const original = request(); const pending = captureDocumentExportSources(original);
    original.sources[0]!.articleId = 1; original.sources[0]!.revisionId = '9223372036854775807';
    const result = await pending;
    expect(decodeDocumentExportSourceCaptureRequest(new Uint8Array(transport.mock.calls[0]![0].requestOptions.body, 16))).toEqual(request());
    expect(result.choices[0]!.coordinate.revisionId).toBe('17'); expect(result.choices[0]!.coordinate.sourceVersion).toBe('9007199254740993');
    expect(transport).toHaveBeenCalledOnce();
});
it('retains exact maximum Int64 revisions and versions with the actual maximum Int32 input', async () => {
    const original = request(); original.sources[0]!.articleId = 2147483647; original.sources[0]!.revisionId = '9223372036854775807';
    const actual = reply(); actual.choices[0]!.coordinate.articleId = '2147483647'; actual.choices[0]!.coordinate.revisionId = '9223372036854775807'; actual.choices[0]!.coordinate.sourceVersion = '9223372036854775807';
    transport.mockResolvedValue(actual);
    const result = await captureDocumentExportSources(original);
    expect(result.choices[0]!.coordinate).toEqual(actual.choices[0]!.coordinate);
});
it.each([0, 2147483648, 42.5])('refuses invalid revision ArticleId %s before HTTP', async articleId => {
    await expect(captureDocumentExportRevisionChoices({ articleId })).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
});
it('refuses invalid capture selectors before HTTP using the sole generated grammar', async () => {
    const original = request(); original.sources[0]!.revisionId = '01';
    await expect(captureDocumentExportSources(original)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
});
it.each(['article', 'revision', 'kind', 'missing'] as const)('keeps a post-write %s mismatch unconfirmed rather than adopting another binding', async mismatch => {
    const actual = reply();
    if (mismatch === 'article') actual.choices[0]!.coordinate.articleId = '43';
    else if (mismatch === 'revision') actual.choices[0]!.coordinate.revisionId = '18';
    else if (mismatch === 'kind') actual.choices[0]!.coordinate = { kind: 1, articleId: '42', draftKey: 'actual-draft', revisionId: null, publicationId: null, sourceVersion: '9007199254740993' };
    else actual.choices = [];
    transport.mockResolvedValue(actual);
    let failure: unknown; try { await captureDocumentExportSources(request()); } catch (error) { failure = error; }
    expect(classifyDocumentExportSourceOptionsFailure(failure)).toBe('uncertain');
    expect(String(failure)).toContain('document_export_source_choices_unconfirmed'); expect(String(failure)).not.toContain('9007199254740993'); expect(transport).toHaveBeenCalledOnce();
});
it('matches the full selected coordinate set without imposing a response ordering', async () => {
    const original = request(); original.sources = [original.sources[0]!, { ...original.sources[0]!, revisionId: '18' }];
    const first = reply().choices[0]!; const second = { ...first, choiceId: 'b'.repeat(64), coordinate: { ...first.coordinate, revisionId: '18', sourceVersion: '9007199254740994' } };
    transport.mockResolvedValue({ choices: [second, first] });
    await expect(captureDocumentExportSources(original)).resolves.toMatchObject({ choices: [second, first] });
    transport.mockResolvedValue({ choices: [first, { ...second, coordinate: first.coordinate }] });
    await expect(captureDocumentExportSources(original)).rejects.toThrow('document_export_source_choices_unconfirmed');
});
it.each(['article', 'draft'] as const)('refuses %s results in article-specific revision enumeration', async mismatch => {
    const actual = reply();
    if (mismatch === 'article') actual.choices[0]!.coordinate.articleId = '43';
    else actual.choices[0]!.coordinate = { kind: 1, articleId: '42', draftKey: 'actual-draft', revisionId: null, publicationId: null, sourceVersion: '9007199254740993' };
    transport.mockResolvedValue(actual);
    await expect(captureDocumentExportRevisionChoices({ articleId: 42 })).rejects.toThrow('document_export_source_choices_unconfirmed');
});
it('accepts actual empty selections and empty revision enumeration without invented entries', async () => {
    transport.mockResolvedValue({ choices: [] });
    await expect(captureDocumentExportSources({ sources: [] })).resolves.toEqual({ choices: [] });
    await expect(captureDocumentExportRevisionChoices({ articleId: 42 })).resolves.toEqual({ choices: [] });
});
it('keeps malformed post-write replies uncertain while invalid local inputs remain definite refusals', async () => {
    const actual = reply(); actual.choices[0]!.coordinate.sourceVersion = '01'; transport.mockResolvedValue(actual);
    let failure: unknown; try { await captureDocumentExportSources(request()); } catch (error) { failure = error; }
    expect(classifyDocumentExportSourceOptionsFailure(failure)).toBe('uncertain');
    expect(classifyDocumentExportSourceOptionsFailure(new RangeError())).toBe('rejected');
});
it.each(['auth_failed', 'forbidden', 'not_found'] as const)('preserves uniform %s permission revocation', async kind => {
    const denial = new BinaryTransportError({ kind, message: 'private details' }); transport.mockRejectedValue(denial);
    await expect(captureDocumentExportSources(request())).rejects.toBe(denial);
    expect(classifyDocumentExportSourceOptionsFailure(denial)).toBe('permission-revoked');
});
it('uses the existing transient command to hold uncertainty without automatic or unsafe retry', async () => {
    transport.mockRejectedValue(new BinaryTransportError({ kind: 'network', message: 'lost' })); const changed = vi.fn();
    const call = createDocumentExportCall({ captureRequest: captureDocumentExportSourceCaptureRequest, execute: captureDocumentExportSources,
        classifyFailure: classifyDocumentExportSourceOptionsFailure, changed, permissionRevoked: vi.fn(), allowUncertainRetry: false });
    await call.start(request()); expect(changed).toHaveBeenLastCalledWith({ phase: 'uncertain' });
    await call.retry(); await call.start({ sources: [] }); expect(transport).toHaveBeenCalledOnce();
});
it.each([500, 502, 503, 504])('keeps normalized HTTP %s post-write failure uncertain without retry', async status => {
    const failure = new BinaryTransportError({ kind: status === 503 ? 'public_artifact_not_ready' : 'network', status, message: 'unconfirmed' });
    transport.mockRejectedValue(failure);
    await expect(captureDocumentExportSources(request())).rejects.toBe(failure);
    expect(classifyDocumentExportSourceOptionsFailure(failure)).toBe('uncertain');
    expect(transport).toHaveBeenCalledOnce();
});
it('performs zero HTTP calls for prior caller cancellation', async () => {
    const caller = new AbortController(); caller.abort();
    await expect(captureDocumentExportSources(request(), caller.signal)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
});
it('aborts pending requests and refuses late choices after original admin generation revocation', async () => {
    let resolve!: (value: unknown) => void; transport.mockImplementation(() => new Promise(complete => { resolve = complete; }));
    const pending = captureDocumentExportSources(request()); const sent = transport.mock.calls[0]![0];
    privateRequestRuntime.advance('admin'); expect(sent.signal.aborted).toBe(true); resolve(reply());
    let failure: unknown; try { await pending; } catch (error) { failure = error; }
    expect(classifyDocumentExportSourceOptionsFailure(failure)).toBe('permission-revoked');
});
it('stops before body read if the admin authority revokes at response headers', async () => {
    const read = vi.fn(() => reply());
    transport.mockImplementation(async options => { privateRequestRuntime.advance('admin'); options.requestOptions.onResponseHeaders(new Headers()); return read(); });
    await expect(captureDocumentExportSources(request())).rejects.toThrow('stale_private_response:admin'); expect(read).not.toHaveBeenCalled();
});
it('keeps original revocation priority over a canceled transport rejection', async () => {
    transport.mockImplementation(async () => { privateRequestRuntime.advance('admin'); throw new DOMException('canceled', 'AbortError'); });
    let failure: unknown; try { await captureDocumentExportRevisionChoices({ articleId: 42 }); } catch (error) { failure = error; }
    expect(classifyDocumentExportSourceOptionsFailure(failure)).toBe('permission-revoked');
});
it('refuses late choices after caller cancellation without claiming the binding write was canceled', async () => {
    const caller = new AbortController(); transport.mockImplementation(async () => { caller.abort(); return reply(); });
    await expect(captureDocumentExportSources(request(), caller.signal)).rejects.toThrow(); expect(transport).toHaveBeenCalledOnce();
});
