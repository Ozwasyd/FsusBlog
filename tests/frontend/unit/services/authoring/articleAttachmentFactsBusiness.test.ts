import { describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/composition/binaryTransport', () => ({ requestBinaryOnly: request }));

import { createArticleAttachmentBusinessState, type AttachmentBusinessSource } from '@/services/authoring/articleAttachmentBusinessState';
import { createArticleAttachmentUploadProvider } from '@/services/authoring/articleAttachmentUploadProvider';
import { createArticleDocumentContext } from '@/services/authoring/articleDocumentContext';

const session = { uploadId: '0123456789abcdef0123456789abcdef', uploadToken: 'owned-secret-token',
    sha256: 'a'.repeat(64), totalBytes: 20_971_520, commitMayHaveStarted: true };
const facts = { schema: 'fsusblog.upload-asset-facts.v1', uploadId: session.uploadId,
    assetId: '01234567-89ab-cdef-0123-456789abcdef', publicUrl: '/uploads/illustration/0123456789abcdef0123456789abcdef.png',
    sha256: session.sha256, assetVersionSha256: 'b'.repeat(64), referenceLedgerSha256: 'c'.repeat(64),
    sizeBytes: session.totalBytes, mimeType: 'image/png', extension: '.png', width: 1, height: 1, referenceRowCount: 0 };
const completed = { uploadId: session.uploadId, status: 'completed', totalBytes: session.totalBytes, uploadedBytes: session.totalBytes };

function fixture() {
    request.mockReset();
    const context = createArticleDocumentContext({ articleId: 7, draftId: 'draft:one', documentId: 'document:one',
        documentEpoch: 1, sourceRevision: 1, draftRevision: 'revision:one', editorSessionId: 'session:one',
        siteScope: 'site:one', userScope: 'user:one', content: 'original source' });
    let source: AttachmentBusinessSource = { context, nodes: [{ intentRef: 'intent:one', nodeId: 'node:one',
        transactionRef: 'transaction:one', providerRef: 'provider:one', contextDigest: context.contextDigest,
        sourceOrder: 0, sourceReferenced: true, disposition: 'current', sourceUrl: facts.publicUrl }] };
    const provider = createArticleAttachmentUploadProvider(session);
    // Controlled authority callbacks do not issue a real reference or cleanup receipt.
    const authority = { verifyIntent: vi.fn(async () => true), observeReference: vi.fn(async () => null),
        observeCleanup: vi.fn(async () => 'required' as const) };
    const prepublish = vi.fn(async () => ({ status: 'allowed' as const, basisContextDigest: context.contextDigest, receiptRef: null }));
    const state = createArticleAttachmentBusinessState({ source: () => source, provider: () => provider, authority, prepublish });
    return { state, authority, prepublish, changeSource: () => {
        const current = createArticleDocumentContext({ ...context, documentEpoch: 2, content: 'external source', contentDigest: undefined });
        source = { context: current, nodes: [{ ...source.nodes[0], contextDigest: current.contextDigest }] };
    } };
}

describe('actual facts-only provider business caller', () => {
    it('keeps large upload facts blocked without an actual business reference receipt', async () => {
        const f = fixture();
        request.mockResolvedValueOnce(completed).mockResolvedValueOnce(facts);
        const result = await f.state.prepublish();
        expect(result.decision.status).toBe('blocked');
        expect(result.projection.items[0]).toMatchObject({ status: 'recovery-required', referenceReceiptRef: null,
            asset: { sizeBytes: session.totalBytes, assetId: facts.assetId }, cleanup: 'required' });
        expect(result.projection.previewResources).toEqual([]);
        expect(f.authority.observeReference).toHaveBeenCalledOnce();
        expect(f.prepublish).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toMatch(/owned-secret-token|"bytes"/u);
        expect(request.mock.calls[1][0].binaryRoute.operationId).toBe('binary_post_upload_uploadId_facts');
    });
    it('preserves current-context rejection and cleanup after a late large facts response', async () => {
        const f = fixture();
        let finish!: (value: unknown) => void;
        request.mockResolvedValueOnce(completed).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const reading = f.state.assess();
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        f.changeSource();
        finish(facts);
        const projection = await reading;
        expect(projection.items[0]).toMatchObject({ status: 'stale', reason: 'source_changed_during_observation',
            referenceReceiptRef: null, cleanup: 'required', asset: { sizeBytes: session.totalBytes } });
        expect(projection.previewResources).toEqual([]);
        expect(f.authority.observeCleanup).toHaveBeenCalled();
        expect(f.prepublish).not.toHaveBeenCalled();
    });
    it('propagates interrupted large facts through the original business caller', async () => {
        const f = fixture();
        const controller = new AbortController();
        let finish!: (value: unknown) => void;
        request.mockResolvedValueOnce(completed).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const reading = f.state.assess(controller.signal);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        controller.abort(new DOMException('Owned caller interrupted', 'AbortError'));
        finish(facts);
        await expect(reading).rejects.toThrow('Owned caller interrupted');
        expect(f.authority.observeReference).not.toHaveBeenCalled();
        expect(f.prepublish).not.toHaveBeenCalled();
    });
});
