import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import {
    compareArticleRevisionSources,
    readArticleRevisionCompareDraftCoordinate,
    type ArticleRevisionCompareRequest,
    type ArticleRevisionCompareDraftCoordinateResponse,
    type ArticleRevisionCompareResponse
} from '@/api/articleRevisionCompare';

vi.mock('@/composition/binaryTransport', () => ({ requestBinaryOnly: vi.fn() }));
vi.mock('@/utils/fingerprint', () => ({ getBrowserFp: () => 'fp-test' }));
const binary = vi.mocked(requestBinaryOnly);
const digest = 'a'.repeat(64);

const request: ArticleRevisionCompareRequest = {
    base: { kind: 1, revisionId: '9007199254740993' },
    compare: { kind: 2, revisionId: '9007199254740995' },
    options: { viewMode: 0, wordSegmentation: 0, contextLineCount: 3, headingNavigation: false, metadataFieldIds: [] },
    budgets: { maxSourceBytes: 1000, maxLineCount: 100, maxTokenCount: 1000, maxOutputBytes: 10000,
        maxMemoryBytes: 100000, maxHunksPerChunk: 100, maxChunks: 10, timeoutMilliseconds: 1000 },
    cancellationIdentity: 'compare-action-1'
};

function response(): ArticleRevisionCompareResponse
{
    const reference = (sourceKind: 1 | 2, revisionId: string) => ({ sourceKind, revisionId, sourceIdentity: `revision:${revisionId}`,
        revisionNo: 1, serverRevision: null, documentEpoch: null, sourceDigest: digest, packageDigest: digest, sourceByteLength: 0 });
    return {
        planReceipt: {
            schemaVersion: 1, requestId: '5dd20a58-6544-4414-8e19-3da388f56a49', status: 0, reasonCode: 'accepted', planDigest: digest,
            basePackageDigest: digest, comparePackageDigest: digest,
            basePackageReference: reference(1, request.base.revisionId!), comparePackageReference: reference(2, request.compare.revisionId!),
            permissionScopeDigest: digest, metadataSchemaDigest: digest, optionsDigest: digest, budgetDigest: digest,
            admissionDigest: digest, cancellationIdentity: request.cancellationIdentity, contentDigest: digest
        },
        sourceDiff: {
            status: 0, chunks: [], baseLines: [], compareLines: [], baseHeadings: [], compareHeadings: [], contextGroups: [], isSuccess: true,
            receipt: { schemaVersion: 1, engineVersion: 'revision-source-diff-v1', segmenterVersion: 'unicode-text-elements-v1',
                structureParserVersion: 'none', status: 0, reasonCode: 'accepted', planDigest: digest, baseSourceDigest: digest,
                compareSourceDigest: digest, baseStructureDigest: digest, compareStructureDigest: digest, budgetDigest: digest,
                admissionDigest: digest, baseSourceByteCount: 0, compareSourceByteCount: 0, baseLineCount: 0, compareLineCount: 0,
                tokenCount: 0, wordEditCount: 0, headingCount: 0, contextGroupCount: 0, hunkCount: 0, chunkCount: 0,
                estimatedMemoryBytes: 0, estimatedOutputBytes: 0, contentDigest: digest },
            attemptReceipt: { semanticContentDigest: digest, status: 0, elapsedMilliseconds: 1, contentDigest: digest }
        }
    };
}

describe('article revision compare transport', () =>
{
    beforeEach(() => vi.clearAllMocks());

    it('uses the author binary admission and preserves exact revision IDs and receipts', async () =>
    {
        const value = response();
        binary.mockResolvedValue(value);
        const signal = new AbortController().signal;
        await expect(compareArticleRevisionSources(42, request, { signal })).resolves.toBe(value);
        const transport = binary.mock.calls[0][0];
        expect(transport.binaryUrl).toBe('/api/binary/author/articles/42/revisions/compare');
        expect(transport.privateScope).toBe('admin');
        expect(transport.frameType).toBe(FrameType.ArticleRevisionCompareResponse);
        expect(transport.signal).toBe(signal);
        expect(transport.requestOptions?.method).toBe('POST');
        expect(transport.requestOptions?.credentials).toBe('include');
        const bytes = new Uint8Array(transport.requestOptions!.body as ArrayBuffer);
        expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true)).toBe(FrameType.ArticleRevisionCompareRequest);
        expect(JSON.parse(new TextDecoder().decode(bytes.subarray(16)))).toEqual(request);
    });

    it.each([
        (value: ArticleRevisionCompareResponse) => { value.planReceipt.cancellationIdentity = 'old-action'; },
        (value: ArticleRevisionCompareResponse) => { value.sourceDiff.receipt.planDigest = 'b'.repeat(64); },
        (value: ArticleRevisionCompareResponse) => { value.planReceipt.comparePackageReference.revisionId = '5'; },
        (value: ArticleRevisionCompareResponse) => { value.sourceDiff.receipt.chunkCount = 1; },
        (value: ArticleRevisionCompareResponse) => { value.sourceDiff.attemptReceipt.semanticContentDigest = 'b'.repeat(64); },
        (value: ArticleRevisionCompareResponse) => { value.planReceipt.planDigest = ''; }
    ])('rejects stale, partial or mismatched service envelopes', async (mutate) =>
    {
        const value = response();
        mutate(value);
        binary.mockResolvedValue(value);
        await expect(compareArticleRevisionSources(42, request)).rejects.toThrow('ARTICLE_REVISION_COMPARE_RECEIPT_INVALID');
    });

    it('propagates transport denial and cancellation without partial success', async () =>
    {
        const denied = new Error('revision_compare_source_unavailable');
        binary.mockRejectedValue(denied);
        await expect(compareArticleRevisionSources(42, request)).rejects.toBe(denied);
        const controller = new AbortController();
        controller.abort();
        binary.mockResolvedValue(response());
        await expect(compareArticleRevisionSources(42, request, { signal: controller.signal })).rejects.toThrow();
    });
});

describe('article revision compare draft coordinate', () =>
{
    beforeEach(() => vi.clearAllMocks());
    const coordinateRequest = { draftKey: 'draft-1', expectedServerRevision: '9007199254740993' };
    const coordinate = (): ArticleRevisionCompareDraftCoordinateResponse => ({
        draftKey: coordinateRequest.draftKey, articleId: 42, serverRevision: coordinateRequest.expectedServerRevision,
        documentEpoch: 'server-owned-persisted-draft-epoch', sourceDigest: digest
    });

    it('preserves the server authority coordinate through the author admission', async () =>
    {
        const value = coordinate();
        binary.mockResolvedValue(value);
        const signal = new AbortController().signal;
        await expect(readArticleRevisionCompareDraftCoordinate(42, coordinateRequest, { signal })).resolves.toBe(value);
        const transport = binary.mock.calls[0][0];
        expect(transport.binaryUrl).toBe('/api/binary/author/articles/42/revisions/compare/draft-coordinate');
        expect(transport.privateScope).toBe('admin');
        expect(transport.frameType).toBe(FrameType.ArticleRevisionCompareDraftCoordinateResponse);
        expect(transport.signal).toBe(signal);
        expect(transport.requestOptions?.method).toBe('POST');
        expect(transport.requestOptions?.credentials).toBe('include');
        const bytes = new Uint8Array(transport.requestOptions!.body as ArrayBuffer);
        expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true)).toBe(FrameType.ArticleRevisionCompareDraftCoordinateRequest);
        expect(JSON.parse(new TextDecoder().decode(bytes.subarray(16)))).toEqual(coordinateRequest);
    });

    it.each([
        (value: ArticleRevisionCompareDraftCoordinateResponse) => { value.articleId = 43; },
        (value: ArticleRevisionCompareDraftCoordinateResponse) => { value.draftKey = 'other-owner-draft'; },
        (value: ArticleRevisionCompareDraftCoordinateResponse) => { value.serverRevision = '9007199254740992'; },
        (value: ArticleRevisionCompareDraftCoordinateResponse) => { value.documentEpoch = ''; },
        (value: ArticleRevisionCompareDraftCoordinateResponse) => { value.sourceDigest = ''; }
    ])('rejects missing or mismatched authority coordinates', async (mutate) =>
    {
        const value = coordinate();
        mutate(value);
        binary.mockResolvedValue(value);
        await expect(readArticleRevisionCompareDraftCoordinate(42, coordinateRequest))
            .rejects.toThrow('ARTICLE_REVISION_COMPARE_DRAFT_COORDINATE_INVALID');
    });

    it('propagates generic denial and interrupted reads', async () =>
    {
        const denied = new Error('article_revision_compare_unavailable');
        binary.mockRejectedValue(denied);
        await expect(readArticleRevisionCompareDraftCoordinate(42, coordinateRequest)).rejects.toBe(denied);
        const controller = new AbortController();
        controller.abort();
        binary.mockResolvedValue(coordinate());
        await expect(readArticleRevisionCompareDraftCoordinate(42, coordinateRequest, { signal: controller.signal })).rejects.toThrow();
    });
});
