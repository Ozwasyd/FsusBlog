import { effectScope, nextTick, reactive } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { useArticleRevisionCompare, type ArticleRevisionCompareInputs } from '@/composables/useArticleRevisionCompare';
import { materializeRevisionSourcePresentation, readRevisionSourceRange, revisionSourceDigest } from '@/services/revisionComparePresentation';

import type { ArticleRevisionCompareResponse } from '@/api/articleRevisionCompare';
import type { ArticleRevisionDetailResponse, ServerDraftResponse } from '@/api/authoring';

// Deliberate unit envelopes test joins/refusals only. They are not backend or browser acceptance receipts.
async function envelope(base: string, compare: string): Promise<ArticleRevisionCompareResponse>
{
    const a = new TextEncoder().encode(base);
    const b = new TextEncoder().encode(compare);
    const baseDigest = await revisionSourceDigest(a);
    const compareDigest = await revisionSourceDigest(b);
    const range = (length: number) => ({ offset: 0, length, end: length });
    return { planReceipt: { planDigest: 'a'.repeat(64), basePackageDigest: 'b'.repeat(64), comparePackageDigest: 'c'.repeat(64),
        basePackageReference: { sourceByteLength: a.length }, comparePackageReference: { sourceByteLength: b.length } },
    sourceDiff: { receipt: { baseSourceByteCount: a.length, compareSourceByteCount: b.length, baseSourceDigest: baseDigest, compareSourceDigest: compareDigest, chunkCount: 1 },
        chunks: [{ index: 0, contentDigest: 'd'.repeat(64), hunks: [{ kind: 3, base: range(a.length), compare: range(b.length), baseStartLine: 0, compareStartLine: 0,
            baseLineCount: 1, compareLineCount: 1, wordEdits: [], headingIdentities: [] }] }], contextGroups: [], baseHeadings: [], compareHeadings: [] }
    } as unknown as ArticleRevisionCompareResponse;
}

function inputs(): ArticleRevisionCompareInputs
{
    return { articleId: 42, compareRevisionId: '9007199254740993', currentRevisionId: '9007199254740995', draftKey: 'draft-42', serverDraftRevision: 4, currentContent: 'new\r\n', contextIdentity: 'current-context' };
}

function ports()
{
    return {
        getArticleRevision: vi.fn(async (articleId: number, id: string) => ({ articleId, id, content: id === '9007199254740993' ? 'old\r\n' : 'new\r\n' }) as ArticleRevisionDetailResponse),
        getServerDraft: vi.fn(async () => ({ articleId: 42, draftKey: 'draft-42', serverRevision: 4, content: 'new\r\n' }) as ServerDraftResponse),
        readArticleRevisionCompareDraftCoordinate: vi.fn(async () => ({ articleId: 42, draftKey: 'draft-42', serverRevision: '4', documentEpoch: 'server-draft-epoch', sourceDigest: await revisionSourceDigest(new TextEncoder().encode('new\r\n')) })),
        compareArticleRevisionSources: vi.fn(async () => envelope('new\r\n', 'old\r\n'))
    };
}

const runScope = () =>
{
    const scope = effectScope();
    const input = reactive(inputs());
    const api = ports();
    const state = scope.run(() => useArticleRevisionCompare(() => input, api))!;
    return { scope, input, api, state };
};

describe('revision source receipt presentation', () =>
{
    it('preserves BOM, CRLF, CJK and HTML as source bytes without rendering HTML', async () =>
    {
        const source = '\uFEFF# 标题\r\n<script>raw</script>\r\n';
        const value = await materializeRevisionSourcePresentation(await envelope(source, source), source, source);
        expect(value.rows[0].base.map(piece => piece.text).join('')).toBe(source);
        expect(value.rows[0].compare.map(piece => piece.text).join('')).toBe(source);
    });

    it('rejects bytes that differ from server digest or length', async () =>
    {
        const value = await envelope('same', 'old');
        await expect(materializeRevisionSourcePresentation(value, 'tame', 'old')).rejects.toThrow('revision_compare_source_stale');
        await expect(materializeRevisionSourcePresentation(value, 'same!', 'old')).rejects.toThrow('revision_compare_source_stale');
    });

    it('rejects overflow and UTF8 cuts, rather than silently replacing source', () =>
    {
        const bytes = new TextEncoder().encode('标题');
        expect(() => readRevisionSourceRange(bytes, { offset: 0, length: 1, end: 1 })).toThrow();
        expect(() => readRevisionSourceRange(bytes, { offset: 5, length: 5, end: 10 })).toThrow('revision_compare_source_range_invalid');
    });
});

describe('single inspector source requests', () =>
{
    it('uses exact current and historical IDs, and re-requests each sealed view mode', async () =>
    {
        const { scope, state, api } = runScope();
        await state.compare();
        expect(state.status.value).toBe('ready');
        expect(api.getArticleRevision.mock.calls.map(call => call[1])).toEqual(['9007199254740993', '9007199254740995']);
        const first = api.compareArticleRevisionSources.mock.calls[0] as unknown as [number, { options: { viewMode: number; }; cancellationIdentity: string; }];
        await state.setMode(1);
        const second = api.compareArticleRevisionSources.mock.calls[1] as unknown as typeof first;
        expect(first[1].options.viewMode).toBe(0);
        expect(second[1].options.viewMode).toBe(1);
        expect(second[1].cancellationIdentity).not.toBe(first[1].cancellationIdentity);
        scope.stop();
    });

    it('consumes the original server draft coordinate, never the editor epoch', async () =>
    {
        const { scope, state, api } = runScope();
        state.baseSelection.value = 'draft';
        await nextTick();
        await state.compare();
        expect(state.status.value).toBe('ready');
        expect(api.readArticleRevisionCompareDraftCoordinate).toHaveBeenCalledWith(42, { draftKey: 'draft-42', expectedServerRevision: '4' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        const call = api.compareArticleRevisionSources.mock.calls[0] as unknown as [number, { base: { documentEpoch: string; }; }];
        expect(call[1].base.documentEpoch).toBe('server-draft-epoch');
        scope.stop();
    });

    it('refuses unsaved or unsafe draft coordinates before invoking the compare service', async () =>
    {
        const { scope, input, state, api } = runScope();
        state.baseSelection.value = 'draft';
        input.currentContent = 'unsaved';
        await nextTick();
        await state.compare();
        expect(state.status.value).toBe('stale');
        expect(api.compareArticleRevisionSources).not.toHaveBeenCalled();
        input.currentContent = 'new\r\n';
        api.getServerDraft.mockResolvedValueOnce({ articleId: 42, draftKey: 'draft-42', serverRevision: Number.MAX_SAFE_INTEGER + 1, content: 'new\r\n' } as ServerDraftResponse);
        await nextTick();
        await state.compare();
        expect(state.status.value).toBe('stale');
        expect(api.compareArticleRevisionSources).not.toHaveBeenCalled();
        scope.stop();
    });

    it('clears verified results after context changes and suppresses late cancelled responses', async () =>
    {
        const { scope, input, state, api } = runScope();
        await state.compare();
        input.contextIdentity = 'changed-epoch';
        await nextTick();
        expect(state.status.value).toBe('stale');
        expect(state.result.value).toBeNull();
        let release!: (value: ArticleRevisionCompareResponse) => void;
        api.compareArticleRevisionSources.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const pending = state.compare();
        await vi.waitFor(() => expect(release).toBeDefined());
        state.cancel();
        release(await envelope('new\r\n', 'old\r\n'));
        await pending;
        expect(state.status.value).toBe('cancelled');
        expect(state.result.value).toBeNull();
        scope.stop();
    });

    it('reports denied, missing, cross-article and mismatched source as unavailable with no partial result', async () =>
    {
        const { scope, state, api } = runScope();
        api.getArticleRevision.mockResolvedValueOnce({ articleId: 43, id: '9007199254740993', content: 'secret' } as ArticleRevisionDetailResponse);
        await state.compare();
        expect(state.status.value).toBe('unavailable');
        expect(state.result.value).toBeNull();
        api.compareArticleRevisionSources.mockRejectedValueOnce(new Error('article_revision_compare_unavailable'));
        await state.compare();
        expect(state.status.value).toBe('unavailable');
        expect(state.result.value).toBeNull();
        scope.stop();
    });
});
