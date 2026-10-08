import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ request: vi.fn(), decode: vi.fn() }));
vi.mock('@/api/binaryApiClient', () => ({ binaryRequest: boundary.request }));
vi.mock('@wasm/aeds', async (original) => ({ ...await original<typeof import('@wasm/aeds')>(), decode: boundary.decode }));

import { revalidateAuthorArticleSelection } from '@/api/authorArticleSelection';
import { decodeAuthorArticleSelectionRevalidationRequest, encodeAuthorArticleSelectionRevalidationResponse, type AuthorArticleSelectionRevalidationRequest, type AuthorArticleSelectionRevalidationResponse } from '@/codecs/binary/authorArticleSelectionWire.generated';
import { binaryFrameDecoderRegistrations } from '@/composition/binaryDecoderRegistry';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';
import { FrameType } from '@wasm/protocol/frame';

const request = (): AuthorArticleSelectionRevalidationRequest => ({ schemaVersion: 1, articleId: 27,
    serverRevision: '9223372036854775807', requestId: '018f1ce7-093a-7a01-bbcc-123456789abc', permissionToken: 'a'.repeat(64) });
const response = (current = true): AuthorArticleSelectionRevalidationResponse => ({ ...request(), current,
    owner: { adminPrincipalId: '9223372036854775807', siteScope: 'primary' }, permissionToken: current ? 'a'.repeat(64) : null });
const decoded = (value = response()) => ({ ok: true, frameType: FrameType.AuthorArticleSelectionRevalidateResponse,
    payloadView: encodeAuthorArticleSelectionRevalidationResponse(value) });

beforeEach(() => { vi.resetAllMocks(); privateRequestRuntime.resetForTests(); boundary.request.mockResolvedValue(new ArrayBuffer(0)); boundary.decode.mockReturnValue(decoded()); });
describe('existing private selection transport', () => {
    it('sends exact typed AEDS2/PoW request and preserves full Int64 reply without query metadata', async () => {
        const result = await revalidateAuthorArticleSelection(request());
        expect(result).toEqual(response()); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.owner)).toBe(true);
        const [url, options] = boundary.request.mock.calls[0];
        expect(url).toBe('/api/binary/author/articles/revalidate-selection'); expect(options.requiresPow).toBe(true); expect(options.method).toBe('POST');
        const bytes = new Uint8Array(options.body); const view = new DataView(options.body);
        expect(bytes.length).toBe(116); expect(view.getUint16(8, true)).toBe(276);
        expect(decodeAuthorArticleSelectionRevalidationRequest(bytes.subarray(16))).toEqual(request());
        expect(result).not.toHaveProperty('title'); expect(result).not.toHaveProperty('slug');
    });
    it('retains request identity across caller mutation after send', async () => {
        const mutable = request(); let complete!: (bytes: ArrayBuffer) => void;
        boundary.request.mockImplementation(() => new Promise<ArrayBuffer>(resolve => { complete = resolve; }));
        const pending = revalidateAuthorArticleSelection(mutable); mutable.serverRevision = '1'; complete(new ArrayBuffer(0));
        expect(await pending).toEqual(response());
    });
    it('returns genuine denial with no token rather than manufacturing current state', async () => {
        boundary.decode.mockReturnValue(decoded(response(false)));
        const result = await revalidateAuthorArticleSelection(request()); expect(result.current).toBe(false); expect(result.permissionToken).toBeNull();
    });
    it.each(['article', 'revision', 'request', 'token'])('rejects a correlated-shape reply with wrong %s', async fault => {
        const value = response();
        if (fault === 'article') value.articleId = 28;
        if (fault === 'revision') value.serverRevision = '1';
        if (fault === 'request') value.requestId = '11111111-1111-1111-1111-111111111111';
        if (fault === 'token') value.permissionToken = 'b'.repeat(64);
        boundary.decode.mockReturnValue(decoded(value)); await expect(revalidateAuthorArticleSelection(request())).rejects.toThrow('author_article_selection_response_invalid');
    });
    it.each(['failed', 'wrong-root', 'json', 'trailing'])('refuses %s frame or payload', async fault => {
        const value = decoded();
        if (fault === 'failed') value.ok = false;
        if (fault === 'wrong-root') value.frameType = FrameType.AuthorArticleSelectionRevalidateRequest;
        if (fault === 'json') value.payloadView = new TextEncoder().encode('{"current":true}');
        if (fault === 'trailing') value.payloadView = Uint8Array.from([...value.payloadView, 0]);
        boundary.decode.mockReturnValue(value); await expect(revalidateAuthorArticleSelection(request())).rejects.toThrow(
            fault === 'failed' || fault === 'wrong-root' ? 'author_article_selection_frame_invalid' : 'author_article_selection_response_invalid');
    });
    it.each(['cancel', 'admin-logout', 'admin-identity-change'])('blocks a late reply after %s even when transport ignores abort', async transition => {
        let complete!: (bytes: ArrayBuffer) => void; const controller = new AbortController();
        boundary.request.mockImplementation(() => new Promise<ArrayBuffer>(resolve => { complete = resolve; }));
        const pending = revalidateAuthorArticleSelection(request(), controller.signal);
        if (transition === 'cancel') controller.abort(); else if (transition === 'admin-logout') privateRequestRuntime.advanceForAuthTransition('admin-logout'); else privateRequestRuntime.advance('admin');
        expect(boundary.request.mock.calls[0][1].signal.aborted).toBe(true); complete(new ArrayBuffer(0));
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(boundary.decode).not.toHaveBeenCalled();
    });
    it('checks identity again after native decode', async () => {
        boundary.decode.mockImplementation(() => { privateRequestRuntime.advance('admin'); return decoded(); });
        await expect(revalidateAuthorArticleSelection(request())).rejects.toMatchObject({ name: 'AbortError' });
    });
    it('registers one closed response decoder with the same literal wire', () => {
        const registrations = binaryFrameDecoderRegistrations.filter(([frame]) => frame === FrameType.AuthorArticleSelectionRevalidateResponse);
        expect(registrations).toHaveLength(1); expect(registrations[0]![1](decoded().payloadView)).toEqual(response());
    });
});
