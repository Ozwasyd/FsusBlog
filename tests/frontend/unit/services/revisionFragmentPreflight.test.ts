import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareArticleRevisionSources } from '@/api/articleRevisionCompare';
import type { ArticleRevisionCompareRequest, ArticleRevisionCompareResponse } from '@/api/articleRevisionCompare';
import { ArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { createRevisionFragmentProposal } from '@/services/revisionFragmentProposal';
import { recheckRevisionFragmentProposal } from '@/services/revisionFragmentPreflight';
import { materializeRevisionSourcePresentation, revisionSourceDigest } from '@/services/revisionComparePresentation';

// Controlled transport/capture inputs only. These controls establish no permission or native qualification.
vi.mock('@/api/articleRevisionCompare', () => ({ compareArticleRevisionSources: vi.fn() }));
const api = vi.mocked(compareArticleRevisionSources);
const hash = (value: string) => value.repeat(64);
const range = (length: number) => ({ offset: 0, length, end: length });

async function fixture() {
    const owner = new ArticleDocumentContextAdapter({ articleId: 42, draftId: 'draft:42',
        editorSessionId: 'session:test', siteScope: 'site:main', userScope: 'user:42',
        content: 'draft', sourceRevision: 7 });
    const selection = { start: 2, end: 4, direction: 'backward' as const };
    const readCurrent = () => ({ document: owner.context, selection: { ...selection } });
    const baseSource = 'current\n';
    const compareSource = '\uFEFF历史😀\r\n<script>source</script>  \r\n';
    const baseBytes = new TextEncoder().encode(baseSource);
    const compareBytes = new TextEncoder().encode(compareSource);
    const baseDigest = await revisionSourceDigest(baseBytes);
    const compareDigest = await revisionSourceDigest(compareBytes);
    const reference = (old: boolean) => ({ sourceKind: old ? 1 : 2, sourceIdentity: old ? 'revision:100:2' : 'revision:200:3',
        revisionId: old ? '100' : '200', revisionNo: old ? 2 : 3, serverRevision: null, documentEpoch: null,
        sourceDigest: old ? compareDigest : baseDigest, packageDigest: old ? hash('c') : hash('b'),
        sourceByteLength: old ? compareBytes.length : baseBytes.length });
    const response = { planReceipt: { status: 0, planDigest: hash('a'), admissionDigest: hash('d'),
        basePackageDigest: hash('b'), comparePackageDigest: hash('c'), basePackageReference: reference(false),
        comparePackageReference: reference(true), permissionScopeDigest: hash('1'), optionsDigest: hash('2'),
        budgetDigest: hash('3'), metadataSchemaDigest: hash('4'), cancellationIdentity: 'original:compare' },
        sourceDiff: { status: 0, isSuccess: true,
            receipt: { status: 0, planDigest: hash('a'), admissionDigest: hash('d'), contentDigest: hash('e'),
                baseSourceDigest: baseDigest, compareSourceDigest: compareDigest, baseSourceByteCount: baseBytes.length,
                compareSourceByteCount: compareBytes.length }, attemptReceipt: { status: 0, semanticContentDigest: hash('e') },
            chunks: [{ index: 0, contentDigest: hash('f'), hunks: [{ kind: 3, baseStartLine: 0, baseLineCount: 1,
                compareStartLine: 0, compareLineCount: 1, base: range(baseBytes.length), compare: range(compareBytes.length),
                wordEdits: [], headingIdentities: [] }] }],
            baseLines: [], compareLines: [], baseHeadings: [], compareHeadings: [], contextGroups: [] }
    } as unknown as ArticleRevisionCompareResponse;
    const presentation = await materializeRevisionSourcePresentation(response, baseSource, compareSource);
    const proposal = await createRevisionFragmentProposal(presentation, { articleId: 42, actionId: 'fragment:test:1',
        planDigest: hash('a'), basePackageDigest: hash('b'), comparePackageDigest: hash('c'), side: 'compare',
        sourceIdentity: 'revision:100:2', sourceDigest: compareDigest, packageDigest: hash('c'), chunkDigest: hash('f'),
        hunkIndex: 0, range: range(compareBytes.length) }, readCurrent);
    const task = owner.beginTask('compare', 'revision-fragment:preflight');
    const captureCurrent = vi.fn(() => ({ document: owner.context, anchor: { range: { start: selection.start,
        end: selection.end }, direction: selection.direction } }));
    const release = vi.fn(() => { if (!task.signal.aborted) task.cancel('test-release'); });
    const caller = { task, captureCurrent, release };
    const request: ArticleRevisionCompareRequest = { base: { kind: 2, revisionId: '200' }, compare: { kind: 1, revisionId: '100' },
        options: { viewMode: 0, wordSegmentation: 0, contextLineCount: 3, headingNavigation: true, metadataFieldIds: [] },
        budgets: { maxSourceBytes: 4096, maxLineCount: 100, maxTokenCount: 1000, maxOutputBytes: 4096,
            maxMemoryBytes: 8192, maxHunksPerChunk: 10, maxChunks: 10, timeoutMilliseconds: 1000 },
        cancellationIdentity: 'original:compare' };
    const fresh = structuredClone(response);
    fresh.planReceipt.planDigest = hash('5');
    fresh.planReceipt.requestId = 'new:authorized-read';
    fresh.planReceipt.cancellationIdentity = task.envelope.requestId;
    fresh.sourceDiff.receipt.planDigest = fresh.planReceipt.planDigest;
    api.mockResolvedValue(fresh);
    return { owner, selection, proposal, presentation, request, caller, fresh };
}

beforeEach(() => { api.mockReset(); });
describe('canonical loan fragment preflight source controls', () => {
    it('keeps the original proposal plan, separate read observation, exact bytes and unexecuted status', async () => {
        const f = await fixture();
        const result = await recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller);
        expect(result.status).toBe('unexecuted');
        expect(result.proposal).toEqual(f.proposal);
        expect(result.proposal.selection.planDigest).toBe(hash('a'));
        expect(result.readObservation.planDigest).toBe(hash('5'));
        expect(result).not.toHaveProperty('permission');
        expect(result).not.toHaveProperty('transaction');
        expect(result).not.toHaveProperty('receipt');
        expect(Object.isFrozen(result.readObservation)).toBe(true);
        expect(api).toHaveBeenCalledWith(42, { ...f.request, cancellationIdentity: f.caller.task.envelope.requestId },
            { signal: f.caller.task.signal });
        expect(f.request.cancellationIdentity).toBe('original:compare');
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it('preserves a real API rejection without substituting a cached permission grant and releases', async () => {
        const f = await fixture();
        const denied = new Error('ArticleWrite denied');
        api.mockRejectedValue(denied);
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toBe(denied);
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it.each(['basePackageReference', 'comparePackageReference'] as const)('rejects %s package drift after authorized read', async field => {
        const f = await fixture();
        f.fresh.planReceipt[field].sourceIdentity += ':drift';
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toThrow('package_or_scope_stale');
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it.each(['permissionScopeDigest', 'optionsDigest', 'budgetDigest', 'metadataSchemaDigest'] as const)('rejects %s drift without rebinding authority', async field => {
        const f = await fixture();
        f.fresh.planReceipt[field] = hash('9');
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toThrow('package_or_scope_stale');
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it('rejects source revision drift during the read', async () => {
        const f = await fixture();
        api.mockImplementation(async () => { f.owner.updateSource('changed'); return f.fresh; });
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toThrow();
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it('rejects native selection movement during the read', async () => {
        const f = await fixture();
        api.mockImplementation(async () => { f.selection.start = 1; return f.fresh; });
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toThrow('input_stale');
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it('rejects original request mutation during the read', async () => {
        const f = await fixture();
        api.mockImplementation(async () => { f.request.options.contextLineCount = 7; return f.fresh; });
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toThrow('input_stale');
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it('rejects disposal during the read and releases', async () => {
        const f = await fixture();
        api.mockImplementation(async () => { f.owner.dispose(); return f.fresh; });
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toThrow();
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it('rejects mismatched original request before making a new read', async () => {
        const f = await fixture();
        f.request.cancellationIdentity = 'another:request';
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toThrow('request_invalid');
        expect(api).not.toHaveBeenCalled();
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
    it('rejects an already released loan before making a new read', async () => {
        const f = await fixture();
        f.caller.release();
        await expect(recheckRevisionFragmentProposal(f.proposal, f.presentation, f.request, f.caller)).rejects.toThrow();
        expect(api).not.toHaveBeenCalled();
    });
    it('rejects proposal byte tampering before making a new read', async () => {
        const f = await fixture();
        const tampered = structuredClone(f.proposal);
        (tampered.fragmentUtf8 as number[])[0] = 0;
        await expect(recheckRevisionFragmentProposal(tampered, f.presentation, f.request, f.caller)).rejects.toThrow('proposal_stale');
        expect(api).not.toHaveBeenCalled();
        expect(f.caller.release).toHaveBeenCalledTimes(1);
    });
});
