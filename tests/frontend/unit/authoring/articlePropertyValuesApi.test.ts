import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decode } from '@wasm/aeds';
import { AEDS_HEADER_LENGTH, AEDS_MAGIC, AEDS_VERSION, FrameType } from '@wasm/protocol/frame';
import { encodeAedsFrame } from '@/api/binaryFrame';
import { articlePropertyValuesApi } from '@/api/articlePropertyValues';
import { decodeArticlePropertyValueReadResponse, encodeArticlePropertyValueReadResponse,
    type ArticlePropertyValueReadResponse } from '@/codecs/binary/articlePropertyValueReadCodecs';
import { privateRequestRuntime } from '@/services/privateRequestRuntime';

// Wire-only fixtures are not persisted/authenticated receipts. Actual binary
// client, registry, generated codec and private-request leases execute below.
const golden = JSON.parse(readFileSync(new URL('../../../fixtures/protocol/article-property-value-read-wire-golden.json', import.meta.url), 'utf8')) as {
    cases: Array<{ name: string; frameType: number; payloadHex: string; valid: boolean }>;
};
const fetchBoundary = vi.fn();
const endpoint = '/api/binary/author/articles/7/properties';
const savedRevision = '9007199254740993';

function witness(name: string): Uint8Array
{
    const entry = golden.cases.find(item => item.name === name);
    if (!entry) throw new Error(`missing_property_wire_witness:${name}`);
    return Uint8Array.from(Buffer.from(entry.payloadHex, 'hex'));
}

function frame(payload = witness('current-0'), type: FrameType = FrameType.ArticlePropertyValueReadResponse): ArrayBuffer
{
    return encodeAedsFrame(type, payload);
}

function reply(value: ArticlePropertyValueReadResponse): Response
{
    return new Response(frame(encodeArticlePropertyValueReadResponse(value)));
}

// Native Wasm extraction is unavailable in this unit environment. This stub
// extracts framing only; real registry and typed v2 validation remain intact.
function decodeAtNativeBoundary(buffer: ArrayBuffer): ReturnType<typeof decode>
{
    const view = new DataView(buffer);
    if (buffer.byteLength < AEDS_HEADER_LENGTH || view.getUint32(0, true) !== AEDS_MAGIC
        || view.getUint8(4) !== AEDS_VERSION)
    {
        return { ok: false, frameType: FrameType.Unknown, payloadView: new Uint8Array(), error: 'diagnostic-invalid-outer-frame' };
    }
    return { ok: true, frameType: view.getUint16(8, true) as FrameType,
        payloadView: new Uint8Array(buffer).subarray(view.getUint8(5)), error: '' };
}

beforeEach(() =>
{
    privateRequestRuntime.resetForTests();
    fetchBoundary.mockReset().mockResolvedValue(new Response(frame()));
    vi.stubGlobal('fetch', fetchBoundary);
    vi.mocked(decode).mockReset().mockImplementation(decodeAtNativeBoundary);
});

afterEach(() =>
{
    privateRequestRuntime.resetForTests();
    vi.unstubAllGlobals();
});

describe('article property persisted read / save revision API boundary', () =>
{
    it('re-reads a matching saved revision via actual private binary transport and registry with all eight typed values', async () =>
    {
        fetchBoundary.mockResolvedValue(new Response(frame(witness('current-8'))));
        const result = await articlePropertyValuesApi.readAfterSave(7, savedRevision, '42');
        expect(result.currentArticleRevisionId).toBe(savedRevision);
        expect(typeof result.currentArticleRevisionId).toBe('string');
        expect(result.scope).toEqual({ definitionOwnerUserId: '42', siteScope: 'primary-site', definitionSchemaVersion: 1 });
        expect(result.current?.snapshot.values.map(item => item.value?.type)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(result.current?.snapshot.values[1].value).toEqual({ type: 1,
            number: { lo: 4294967295, mid: 4294967295, hi: 4294967295, scale: 28, negative: true } });
        expect(result.current?.snapshot.values[2].value).toEqual({ type: 2, boolean: false });
        expect(result.current?.snapshot.values[3].value).toEqual({ type: 3, utc: '638954208000000001' });
        const [url, options] = fetchBoundary.mock.calls[0] as [string, RequestInit];
        expect(new URL(url).pathname).toBe(endpoint);
        expect(new URL(url).searchParams.get('ownerUserId')).toBe('42');
        expect(options).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'include' });
        expect(new Headers(options.headers).get('Accept')).toBe('application/octet-stream');
        expect(options.body).toBeUndefined();
        expect(fetchBoundary).toHaveBeenCalledOnce();
    });

    it.each([[null, 'empty-site-owner'], ['42', 'current-0']] as const)('retains explicit empty-definition scope for owner %s', async (owner, name) =>
    {
        fetchBoundary.mockResolvedValue(new Response(frame(witness(name))));
        const result = await articlePropertyValuesApi.readAfterSave(7, savedRevision, owner);
        expect(result.current).toBeNull();
        expect(result.definitions).toEqual([]);
        expect(result.scope).toEqual({ definitionOwnerUserId: owner, siteScope: 'primary-site', definitionSchemaVersion: 1 });
        const url = new URL(fetchBoundary.mock.calls[0][0] as string);
        expect(url.searchParams.get('ownerUserId')).toBe(owner);
        expect([...url.searchParams.keys()]).toEqual(owner === null ? [] : ['ownerUserId']);
    });

    it('uses the explicit site-owner scope when ordinary read omits the owner query', async () =>
    {
        fetchBoundary.mockResolvedValue(new Response(frame(witness('empty-site-owner'))));
        const result = await articlePropertyValuesApi.read(7);
        expect(result.scope.definitionOwnerUserId).toBeNull();
        expect(result.definitions).toEqual([]);
        expect(new URL(fetchBoundary.mock.calls[0][0] as string).search).toBe('');
    });

    it('retains authoritative user scope with a persisted snapshot and no definition descriptors', async () =>
    {
        fetchBoundary.mockResolvedValue(new Response(frame(witness('current-no-definitions'))));
        const result = await articlePropertyValuesApi.readAfterSave(7, savedRevision, '42');
        expect(result.definitions).toEqual([]);
        expect(result.current).not.toBeNull();
        expect(result.scope).toEqual({ definitionOwnerUserId: '42', siteScope: 'primary-site', definitionSchemaVersion: 1 });
        expect(result.current?.snapshot.coordinates.definitionOwnerUserId).toBe('42');
    });

    it('rejects a real decoded post-save revision race and permits a later independent matching re-read', async () =>
    {
        fetchBoundary.mockImplementation(async () => new Response(frame()));
        await expect(articlePropertyValuesApi.readAfterSave(7, '9007199254740992', '42'))
            .rejects.toThrow('article_property_value_save_revision_changed');
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, '42'))
            .resolves.toMatchObject({ currentArticleRevisionId: savedRevision });
        expect(fetchBoundary).toHaveBeenCalledTimes(2);
        expect(decode).toHaveBeenCalledTimes(2);
    });

    it.each(['1', savedRevision, '9223372036854775807'])('preserves valid saved revision string %s without JS rounding', async revision =>
    {
        const expected = decodeArticlePropertyValueReadResponse(witness('current-0'));
        expected.currentArticleRevisionId = revision;
        fetchBoundary.mockResolvedValue(reply(expected));
        const result = await articlePropertyValuesApi.readAfterSave(7, revision, '42');
        expect(result.currentArticleRevisionId).toBe(revision);
        expect(typeof result.currentArticleRevisionId).toBe('string');
    });

    it.each(['', '0', '01', '+1', '-1', '1.0', '1e2', ' 1', '1 ', '9223372036854775808', '99999999999999999999',
        9007199254740992, null, undefined])('rejects invalid saved revision %s before any IO', async revision =>
    {
        await expect(articlePropertyValuesApi.readAfterSave(7, revision as unknown as string, '42'))
            .rejects.toThrow('article_property_value_article_revision_id_invalid');
        expect(fetchBoundary).not.toHaveBeenCalled();
        expect(decode).not.toHaveBeenCalled();
    });

    it('keeps maximum int64 definition owner exact in request query and empty response scope', async () =>
    {
        const expected = decodeArticlePropertyValueReadResponse(witness('empty-other-owner-site'));
        expected.scope.siteScope = 'primary-site';
        fetchBoundary.mockResolvedValue(reply(expected));
        const result = await articlePropertyValuesApi.readAfterSave(7, savedRevision, '9223372036854775807');
        expect(result.scope.definitionOwnerUserId).toBe('9223372036854775807');
        expect(new URL(fetchBoundary.mock.calls[0][0] as string).searchParams.get('ownerUserId')).toBe('9223372036854775807');
    });

    it.each(['0', '01', '+42', '-1', '1e2', '9223372036854775808', 42])('rejects invalid requested owner %s before IO', async owner =>
    {
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, owner as unknown as string))
            .rejects.toThrow('article_property_value_owner_id_invalid');
        expect(fetchBoundary).not.toHaveBeenCalled();
    });

    it.each([
        { requested: null, actual: '42', site: 'primary-site' },
        { requested: '42', actual: null, site: 'primary-site' },
        { requested: '42', actual: '43', site: 'primary-site' },
        { requested: '42', actual: '42', site: 'secondary-site' }
    ])('rejects internally valid empty scope $actual/$site for requested owner $requested', async ({ requested, actual, site }) =>
    {
        const value = decodeArticlePropertyValueReadResponse(witness('current-0'));
        Object.assign(value.scope, { definitionOwnerUserId: actual, siteScope: site });
        fetchBoundary.mockResolvedValue(reply(value));
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, requested))
            .rejects.toThrow('article_property_value_read_scope_changed');
        expect(fetchBoundary).toHaveBeenCalledOnce();
    });

    it('rejects a different article even when its saved revision and empty definition scope match', async () =>
    {
        const value = decodeArticlePropertyValueReadResponse(witness('current-0'));
        value.articleId = 8;
        fetchBoundary.mockResolvedValue(reply(value));
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, '42'))
            .rejects.toThrow('article_property_value_read_scope_changed');
        expect(fetchBoundary).toHaveBeenCalledOnce();
    });

    it.each(['scope-owner-mismatch', 'scope-site-mismatch', 'scope-schema-unknown', 'scope-owner-zero',
        'scope-missing', 'snapshot-only-owner-mismatch', 'snapshot-only-site-mismatch', 'last-definition-owner-mismatch',
        'trailing', 'truncated', 'retired-v1-current-0'])('rejects actual %s witness through the registered v2 codec without fallback', async name =>
    {
        fetchBoundary.mockResolvedValue(new Response(frame(witness(name))));
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, '42'))
            .rejects.toMatchObject({ name: 'BinaryTransportError', message: 'article_property_value_read_wire_invalid' });
        expect(fetchBoundary).toHaveBeenCalledOnce();
        expect(fetchBoundary.mock.calls[0][1].method).toBe('GET');
    });

    it('rejects a response carried under a different root frame', async () =>
    {
        fetchBoundary.mockResolvedValue(new Response(frame(witness('current-0'), FrameType.AuthoringWorkspaceSnapshotResponse)));
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, '42'))
            .rejects.toMatchObject({ name: 'BinaryTransportError', kind: 'decode_failed', message: 'frame_type_unexpected' });
        expect(fetchBoundary).toHaveBeenCalledOnce();
    });

    it.each(['caller-abort', 'admin-logout'] as const)('rejects late post-save IO after %s and recovers on a fresh read', async transition =>
    {
        let finish!: (response: Response) => void;
        fetchBoundary.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
        const caller = new AbortController();
        const pending = articlePropertyValuesApi.readAfterSave(7, savedRevision, '42', caller.signal);
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(fetchBoundary).toHaveBeenCalledOnce());
        const signal = (fetchBoundary.mock.calls[0][1] as RequestInit).signal!;
        if (transition === 'caller-abort') caller.abort();
        else privateRequestRuntime.advanceForAuthTransition('admin-logout');
        expect(signal.aborted).toBe(true);
        finish(new Response(frame()));
        await rejection;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(decode).not.toHaveBeenCalled();
        fetchBoundary.mockResolvedValue(new Response(frame()));
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, '42'))
            .resolves.toMatchObject({ scope: { definitionOwnerUserId: '42' }, currentArticleRevisionId: savedRevision });
    });

    it('rejects an already-aborted caller before fetch', async () =>
    {
        const caller = new AbortController();
        caller.abort();
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, '42', caller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchBoundary).not.toHaveBeenCalled();
    });

    it('checks actual admin generation after native decode before returning persisted facts', async () =>
    {
        vi.mocked(decode).mockImplementation(buffer =>
        {
            const decoded = decodeAtNativeBoundary(buffer);
            privateRequestRuntime.advanceForAuthTransition('admin-logout');
            return decoded;
        });
        await expect(articlePropertyValuesApi.readAfterSave(7, savedRevision, '42'))
            .rejects.toMatchObject({ name: 'AbortError', scope: 'admin' });
    });
});
