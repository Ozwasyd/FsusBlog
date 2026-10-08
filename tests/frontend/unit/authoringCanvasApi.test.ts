import { beforeEach, describe, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({ request: vi.fn(), decode: vi.fn() }));
vi.mock('@/api/binaryApiClient', () => ({ binaryRequest: boundary.request }));
vi.mock('@wasm/aeds', async (importOriginal) => ({
    ...await importOriginal<typeof import('@wasm/aeds')>(),
    decode: boundary.decode
}));
import { authoringCanvasApi } from '@/api/authoringCanvas';
import { FrameType } from '@wasm/protocol/frame';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { decodeAuthoringCanvasCreateRequest, encodeAuthoringCanvasDocumentHeader,
    encodeAuthoringCanvasListResponse } from '@/codecs/binary/authoringCanvasWire.generated';
const id = '11111111-1111-1111-1111-111111111111';
const requestId = '22222222-2222-2222-2222-222222222222';
const owner = { adminPrincipalId: '9223372036854775807', siteScope: 'primary-site' };
const header = { id, owner, schemaVersion: 1, revision: '1', title: 'Canvas', viewport: { x: 0, y: 0, zoom: 1 },
    nodeCount: 0, edgeCount: 0, createdAtUtc: '0', updatedAtUtc: '0', contentDigest: 'a'.repeat(64) };
beforeEach(() => { vi.resetAllMocks(); privateRequestRuntime.resetForTests(); boundary.request.mockResolvedValue(new ArrayBuffer(0)); });
describe('Canvas typed AEDS boundary', () => {
    it('reads an empty typed list with its actual int64 owner context', async () => {
        boundary.decode.mockReturnValue({ ok: true, frameType: FrameType.AuthoringCanvasListResponse,
            payloadView: encodeAuthoringCanvasListResponse({ owner, items: [], nextCursor: null }) });
        const result = await authoringCanvasApi.list();
        expect(result.owner).toEqual(owner);
        expect(boundary.request.mock.calls[0][0]).toBe('/api/binary/author/canvases?limit=100');
    });
    it('sends a real AEDS v2 create frame through the shared session/CSRF/PoW transport', async () => {
        boundary.decode.mockReturnValue({ ok: true, frameType: FrameType.AuthoringCanvasDocumentHeader,
            payloadView: encodeAuthoringCanvasDocumentHeader(header) });
        const request = { canvasId: id, requestId, title: 'Canvas', viewport: { x: 0, y: 0, zoom: 1 } };
        expect(await authoringCanvasApi.create(request)).toEqual(header);
        const options = boundary.request.mock.calls[0][1];
        expect(options.method).toBe('POST'); expect(options.requiresPow).toBe(true);
        expect(options.body).toBeInstanceOf(ArrayBuffer);
        const bytes = new Uint8Array(options.body); const view = new DataView(options.body);
        expect(view.getUint8(4)).toBe(2);
        expect(view.getUint16(8, true)).toBe(FrameType.AuthoringCanvasCreateRequest);
        expect(decodeAuthoringCanvasCreateRequest(bytes.subarray(view.getUint8(5)))).toEqual(request);
        expect(request).not.toHaveProperty('owner'); expect(request).not.toHaveProperty('actor');
    });
    it('refuses a valid payload carried under a different root frame', async () => {
        boundary.decode.mockReturnValue({ ok: true, frameType: FrameType.AuthoringCanvasListResponse,
            payloadView: encodeAuthoringCanvasDocumentHeader(header) });
        await expect(authoringCanvasApi.header(id)).rejects.toThrow('canvas_aeds_frame_invalid');
    });
    it('refuses a failed outer AEDS decode', async () => {
        boundary.decode.mockReturnValue({ ok: false });
        await expect(authoringCanvasApi.header(id)).rejects.toThrow('canvas_aeds_frame_invalid');
    });
    it.each(['schema', 'trailing', 'text-json'])('refuses %s response without fallback', async defect => {
        let payload = encodeAuthoringCanvasDocumentHeader(header);
        if (defect === 'schema') payload[0] = 2;
        if (defect === 'trailing') { const changed = new Uint8Array(payload.length + 1); changed.set(payload); payload = changed; }
        if (defect === 'text-json') payload = new TextEncoder().encode('{"id":"' + id + '"}');
        boundary.decode.mockReturnValue({ ok: true, frameType: FrameType.AuthoringCanvasDocumentHeader, payloadView: payload });
        await expect(authoringCanvasApi.header(id)).rejects.toThrow('canvas_aeds_payload_invalid');
    });
    it('preserves cancellation on the shared binary request', async () => {
        const controller = new AbortController();
        let complete!: (buffer: ArrayBuffer) => void;
        boundary.request.mockImplementation(() => new Promise<ArrayBuffer>(resolve => { complete = resolve; }));
        const request = authoringCanvasApi.list(null, controller.signal);
        const leaseSignal = boundary.request.mock.calls[0][1].signal;
        expect(leaseSignal).toBeInstanceOf(AbortSignal);
        controller.abort();
        expect(leaseSignal.aborted).toBe(true);
        complete(new ArrayBuffer(0));
        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        expect(boundary.decode).not.toHaveBeenCalled();
    });
    it('rejects a late admin response after actual admin logout even when transport ignores its abort', async () => {
        let complete!: (buffer: ArrayBuffer) => void;
        boundary.request.mockImplementation(() => new Promise<ArrayBuffer>(resolve => { complete = resolve; }));
        const request = authoringCanvasApi.list();
        const leaseSignal = boundary.request.mock.calls[0][1].signal;
        privateRequestRuntime.advanceForAuthTransition('admin-logout');
        expect(leaseSignal.aborted).toBe(true);
        complete(new ArrayBuffer(0));
        await expect(request).rejects.toMatchObject({ name: 'AbortError', scope: 'admin' });
        expect(boundary.decode).not.toHaveBeenCalled();
    });
    it('checks the actual admin generation after decode before granting response success', async () => {
        boundary.decode.mockImplementation(() => {
            privateRequestRuntime.advance('admin');
            return { ok: true, frameType: FrameType.AuthoringCanvasListResponse,
                payloadView: encodeAuthoringCanvasListResponse({ owner, items: [], nextCursor: null }) };
        });
        await expect(authoringCanvasApi.list()).rejects.toMatchObject({ name: 'AbortError', scope: 'admin' });
    });
    it('keeps an independent admin request valid across account logout', async () => {
        let complete!: (buffer: ArrayBuffer) => void;
        boundary.request.mockImplementation(() => new Promise<ArrayBuffer>(resolve => { complete = resolve; }));
        boundary.decode.mockReturnValue({ ok: true, frameType: FrameType.AuthoringCanvasListResponse,
            payloadView: encodeAuthoringCanvasListResponse({ owner, items: [], nextCursor: null }) });
        const request = authoringCanvasApi.list();
        const leaseSignal = boundary.request.mock.calls[0][1].signal;
        privateRequestRuntime.advanceForAuthTransition('logout');
        expect(leaseSignal.aborted).toBe(false);
        complete(new ArrayBuffer(0));
        expect((await request).owner).toEqual(owner);
    });
});
