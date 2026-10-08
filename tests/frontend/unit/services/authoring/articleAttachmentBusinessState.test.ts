import { describe, expect, it, vi } from 'vitest';
import { createArticleDocumentContext } from '@/services/authoring/articleDocumentContext';
import {
    createArticleAttachmentBusinessState,
    type AttachmentBusinessAuthority,
    type AttachmentBusinessNode,
    type AttachmentBusinessPorts,
    type AttachmentBusinessSource
} from '@/services/authoring/articleAttachmentBusinessState';
import type { AttachmentAssetFacts, AttachmentUploadObservation } from '@/services/authoring/articleAttachmentUploadProvider';

const asset: AttachmentAssetFacts = {
    assetId: '01234567-89ab-cdef-0123-456789abcdef', publicUrl: '/uploads/illustration/0123456789abcdef0123456789abcdef.png',
    sha256: 'a'.repeat(64), assetVersionSha256: 'b'.repeat(64), referenceLedgerSha256: 'c'.repeat(64), sizeBytes: 67
};

function fixture(observation: AttachmentUploadObservation = { status: 'committed', asset })
{
    const context = createArticleDocumentContext({ articleId: 7, draftId: 'draft:one', documentId: 'document:one',
        documentEpoch: 1, sourceRevision: 1, draftRevision: 'revision:one', editorSessionId: 'session:one',
        siteScope: 'site:one', userScope: 'user:one', content: 'original source' });
    const node: AttachmentBusinessNode = { intentRef: 'intent:one', nodeId: 'node:one', transactionRef: 'transaction:one',
        providerRef: 'provider:one', contextDigest: context.contextDigest, sourceOrder: 0, sourceReferenced: true,
        disposition: 'current', sourceUrl: asset.publicUrl };
    let source: AttachmentBusinessSource = { context, nodes: [node] };
    const provider = { observe: vi.fn(async () => observation), retryCommit: vi.fn(async () => observation), cancel: vi.fn(async () => observation) };
    // Controlled authority callbacks are test oracles, not a production reference/rights receipt.
    const authority: AttachmentBusinessAuthority = {
        verifyIntent: vi.fn(async () => true),
        observeReference: vi.fn(async (n, a, c) => ({ receiptRef: 'reference:one', contextDigest: c.contextDigest,
            intentRef: n.intentRef, nodeId: n.nodeId, transactionRef: n.transactionRef, assetId: a.assetId,
            assetVersionSha256: a.assetVersionSha256, referenceLedgerSha256: a.referenceLedgerSha256 })),
        observeCleanup: vi.fn(async () => 'recorded')
    };
    const ports: AttachmentBusinessPorts = {
        source: () => source, provider: () => provider, authority,
        saveDraft: vi.fn(async c => ({ status: 'saved', basisContextDigest: c.contextDigest, receiptRef: 'save:one' })),
        confirmLeave: vi.fn(async p => ({ status: 'allowed', basisContextDigest: p.context.contextDigest, receiptRef: 'leave:one' })),
        prepublish: vi.fn(async c => ({ status: 'allowed', basisContextDigest: c.contextDigest, receiptRef: 'publish:one' })),
        revisionSnapshot: vi.fn(async c => ({ status: 'allowed', basisContextDigest: c.contextDigest, receiptRef: 'revision:one' }))
    };
    return { context, node, ports, provider, authority, state: createArticleAttachmentBusinessState(ports),
        source: () => source, setSource: (next: AttachmentBusinessSource) => { source = next; } };
}

describe('attachment business contribution to original owners', () => {
    it.each(['pending', 'failed', 'cancelled', 'recovery-required'] as const)('preserves actual %s refs during save and blocks publish/revision/leave', async status => {
        const observation: AttachmentUploadObservation = status === 'pending' ? { status, uploadedBytes: 12, totalBytes: 67 }
            : status === 'cancelled' ? { status, reason: 'original-abort-acknowledged' } : { status, reason: 'actual-operation-failed' };
        const f = fixture(observation);
        const saved = await f.state.save();
        expect(saved.decision.status).toBe('saved');
        expect(saved.projection.items[0].status).toBe(status);
        const refs = vi.mocked(f.ports.saveDraft!).mock.calls[0][1];
        expect(refs[0]).toMatchObject({ status, assetId: null, referenceLedgerSha256: null });
        expect(JSON.stringify(refs)).not.toMatch(/uploadedBytes|publicUrl|bytes|token|caption/u);
        expect((await f.state.prepublish()).decision.status).toBe('blocked');
        expect((await f.state.revision()).decision.status).toBe('blocked');
        expect(f.ports.prepublish).not.toHaveBeenCalled();
        expect((await f.state.leave()).decision.status).toBe('blocked');
        expect(f.ports.confirmLeave).toHaveBeenCalledOnce();
        expect(saved.projection.previewResources).toEqual([]);
    });

    it('uses exact current reference facts and original callbacks for successful resources', async () => {
        const f = fixture();
        const publish = await f.state.prepublish();
        expect(publish.decision.status).toBe('allowed');
        expect(publish.projection.previewResources).toEqual([{ nodeId: 'node:one', assetId: asset.assetId, publicUrl: asset.publicUrl }]);
        expect((await f.state.revision()).decision.receiptRef).toBe('revision:one');
        expect(vi.mocked(f.ports.revisionSnapshot!).mock.calls[0][1][0]).toMatchObject({
            nodeId: 'node:one', transactionRef: 'transaction:one', assetId: asset.assetId,
            assetVersionSha256: asset.assetVersionSha256, referenceLedgerSha256: asset.referenceLedgerSha256
        });
        expect(await f.state.verify(publish.projection)).toBe(true);
        expect(Object.isFrozen(publish.projection.items)).toBe(true);
    });

    it('does not promote real upload ledger facts into an article operation grant', async () => {
        const f = fixture();
        const ports = { ...f.ports, authority: undefined };
        const state = createArticleAttachmentBusinessState(ports);
        const result = await state.prepublish();
        expect(result.projection.items[0]).toMatchObject({ status: 'recovery-required', reason: 'intent_authority_missing', cleanup: 'required' });
        expect(result.decision.status).toBe('blocked');
        expect(ports.prepublish).not.toHaveBeenCalled();
        expect((await state.retry('node:one')).decision.status).toBe('blocked');
        expect(f.provider.retryCommit).not.toHaveBeenCalled();
    });

    it.each(['assetId', 'assetVersionSha256', 'referenceLedgerSha256', 'contextDigest', 'nodeId', 'transactionRef'] as const)('rejects changed reference %s', async key => {
        const f = fixture();
        const original = f.authority.observeReference;
        f.authority.observeReference = async (...args) => ({ ...(await original(...args))!, [key]: 'changed' });
        expect((await f.state.prepublish()).decision.status).toBe('blocked');
        expect(f.ports.prepublish).not.toHaveBeenCalled();
    });

    it('rejects placeholder or URL-only identity and never exposes it in preview', async () => {
        const f = fixture();
        f.setSource({ context: f.context, nodes: [{ ...f.node, sourceUrl: 'internal:pending-image' }] });
        const result = await f.state.prepublish();
        expect(result.decision.status).toBe('blocked');
        expect(result.projection.previewResources).toEqual([]);
    });

    it.each(['removed', 'cancelled'] as const)('admits unreferenced %s only after original cleanup observation', async disposition => {
        const f = fixture();
        f.setSource({ context: f.context, nodes: [{ ...f.node, disposition, sourceReferenced: false, sourceUrl: null }] });
        expect((await f.state.prepublish()).decision.status).toBe('allowed');
        expect(f.authority.observeCleanup).toHaveBeenCalled();
        f.authority.observeCleanup = async () => 'required';
        expect((await f.state.prepublish()).decision.status).toBe('blocked');
        expect((await f.state.leave()).decision.status).toBe('blocked');
    });

    it('routes late committed facts into cleanup and rejects source/epoch changes', async () => {
        const f = fixture();
        f.provider.observe.mockImplementation(async () => {
            const context = createArticleDocumentContext({ ...f.context, contentDigest: undefined, documentEpoch: 2, content: 'external rebase' });
            f.setSource({ context, nodes: [{ ...f.node, contextDigest: context.contextDigest }] });
            return { status: 'committed', asset };
        });
        const result = await f.state.save();
        expect(result.decision.status).toBe('conflict');
        expect(result.projection.items[0].status).toBe('stale');
        expect(f.authority.observeCleanup).toHaveBeenCalled();
        expect(f.ports.saveDraft).not.toHaveBeenCalled();
    });

    it.each(['current', 'stale', 'removed', 'cancelled'] as const)('saves explicit %s state without dropping identity or recovery refs', async disposition => {
        const f = fixture();
        f.setSource({ context: f.context, nodes: [{ ...f.node, disposition }] });
        const result = await f.state.save();
        expect(result.decision.status).toBe('saved');
        expect(result.projection.items[0].status).toBe(disposition === 'current' ? 'success' : disposition);
        expect(vi.mocked(f.ports.saveDraft!).mock.calls[0][1][0]).toMatchObject({ nodeId: f.node.nodeId, intentRef: f.node.intentRef });
    });
    it('permits the original save acknowledgement draft revision and rejects that drift during publish', async () => {
        const f = fixture();
        f.ports.saveDraft = async c => {
            const context = createArticleDocumentContext({ ...f.context, draftRevision: 'revision:two' });
            f.setSource({ context, nodes: [{ ...f.node, contextDigest: context.contextDigest }] });
            return { status: 'saved', basisContextDigest: c.contextDigest, receiptRef: 'save:two' };
        };
        expect((await f.state.save()).decision.status).toBe('saved');
        const p = fixture();
        p.ports.prepublish = async c => {
            const context = createArticleDocumentContext({ ...p.context, draftRevision: 'revision:two' });
            p.setSource({ context, nodes: [{ ...p.node, contextDigest: context.contextDigest }] });
            return { status: 'allowed', basisContextDigest: c.contextDigest, receiptRef: 'publish:two' };
        };
        expect((await p.state.prepublish()).decision.status).toBe('conflict');
    });
    it('detects node removal while save is running without rewriting history', async () => {
        const f = fixture();
        f.ports.saveDraft = async c => {
            f.setSource({ context: f.context, nodes: [] });
            return { status: 'saved', basisContextDigest: c.contextDigest, receiptRef: 'save:one' };
        };
        expect((await f.state.save()).decision.status).toBe('conflict');
    });

    it('preserves original save retry/conflict and original prepublish refusal', async () => {
        const f = fixture();
        f.ports.saveDraft = async c => ({ status: 'conflict', basisContextDigest: c.contextDigest, receiptRef: null });
        expect((await f.state.save()).decision.status).toBe('conflict');
        f.ports.saveDraft = async () => { throw new Error('private-token-secret'); };
        const failure = await f.state.save();
        expect(failure.decision.status).toBe('failed');
        expect(JSON.stringify(failure)).not.toContain('private-token-secret');
        f.ports.prepublish = async c => ({ status: 'blocked', basisContextDigest: c.contextDigest, receiptRef: null });
        expect((await f.state.prepublish()).decision.status).toBe('blocked');
    });

    it('re-observes provider/reference facts when verifying receipt and ledger tamper', async () => {
        const f = fixture();
        const original = await f.state.assess();
        const changed = JSON.parse(JSON.stringify(original));
        changed.items[0].asset.assetId = 'unverified';
        expect(await f.state.verify(changed)).toBe(false);
        f.provider.observe.mockResolvedValue({ status: 'committed', asset: { ...asset, referenceLedgerSha256: 'd'.repeat(64) } });
        expect(await f.state.verify(original)).toBe(false);
    });

    it('ignores caption fields and rejects duplicated identity/source order', async () => {
        const f = fixture();
        f.setSource({ context: f.context, nodes: [{ ...f.node, ...{ caption: 'private caption state' } }] });
        const result = await f.state.prepublish();
        expect(result.decision.status).toBe('allowed');
        expect(JSON.stringify(result)).not.toContain('private caption state');
        f.setSource({ context: f.context, nodes: [f.node, f.node] });
        await expect(f.state.assess()).rejects.toThrow('attachment_source_node_invalid');
    });

    it('calls actual owned retry/cancel ports and respects interrupted work', async () => {
        const f = fixture();
        await f.state.retry('node:one');
        await f.state.cancel('node:one');
        expect(f.provider.retryCommit).toHaveBeenCalledOnce();
        expect(f.provider.cancel).toHaveBeenCalledOnce();
        const controller = new AbortController();
        controller.abort();
        await expect(f.state.retry('node:one', controller.signal)).rejects.toThrow();
    });
});
