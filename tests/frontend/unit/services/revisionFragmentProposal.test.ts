import { describe, expect, it } from 'vitest';

import type { ArticleRevisionCompareResponse } from '@/api/articleRevisionCompare';
import { createArticleDocumentContext } from '@/services/authoring/articleDocumentContext';
import { createRevisionFragmentProposal } from '@/services/revisionFragmentProposal';
import type { RevisionFragmentCurrentSnapshot, RevisionFragmentSelection } from '@/services/revisionFragmentProposal';
import { materializeRevisionSourcePresentation, revisionSourceDigest } from '@/services/revisionComparePresentation';

const digest = (value: string) => value.repeat(64);
const range = (offset: number, length: number) => ({ offset, length, end: offset + length });
const current = (changes = {}): RevisionFragmentCurrentSnapshot => ({
    document: createArticleDocumentContext({ articleId: 42, draftId: 'draft:42', documentId: 'document:42',
        documentEpoch: 3, sourceRevision: 7, draftRevision: 'draft-revision:7', editorSessionId: 'session:42',
        siteScope: 'site:42', userScope: 'user:42', content: 'current draft', ...changes }),
    selection: { start: 3, end: 5, direction: 'backward' }
});

// Controlled compare fixture; no authorization, historical package or native host qualification is claimed.
async function fixture(source = '\uFEFF# 中文😀\r\n<script>plain source</script>  \r\n') {
    const base = new TextEncoder().encode('current revision\n');
    const compare = new TextEncoder().encode(source);
    const baseDigest = await revisionSourceDigest(base);
    const compareDigest = await revisionSourceDigest(compare);
    const reference = (historical: boolean) => ({ sourceKind: historical ? 1 : 2, sourceIdentity: historical ? 'revision:old:2' : 'revision:current:3',
        revisionId: historical ? 'old' : 'current', revisionNo: historical ? 2 : 3, serverRevision: null, documentEpoch: null,
        sourceDigest: historical ? compareDigest : baseDigest, packageDigest: historical ? digest('c') : digest('b'),
        sourceByteLength: historical ? compare.length : base.length });
    const response = {
        planReceipt: { status: 0, planDigest: digest('a'), basePackageDigest: digest('b'), comparePackageDigest: digest('c'),
            admissionDigest: digest('d'), basePackageReference: reference(false), comparePackageReference: reference(true) },
        sourceDiff: { status: 0, isSuccess: true,
            receipt: { status: 0, planDigest: digest('a'), admissionDigest: digest('d'), contentDigest: digest('e'),
                baseSourceDigest: baseDigest, compareSourceDigest: compareDigest, baseSourceByteCount: base.length,
                compareSourceByteCount: compare.length },
            attemptReceipt: { status: 0, semanticContentDigest: digest('e') },
            chunks: [{ index: 0, contentDigest: digest('f'), hunks: [{ kind: 3, baseStartLine: 0, baseLineCount: 1,
                compareStartLine: 0, compareLineCount: 2, base: range(0, base.length), compare: range(0, compare.length),
                wordEdits: [], headingIdentities: [] }] }],
            baseLines: [], compareLines: [], baseHeadings: [], compareHeadings: [], contextGroups: [] }
    } as unknown as ArticleRevisionCompareResponse;
    const presentation = await materializeRevisionSourcePresentation(response, 'current revision\n', source);
    const selection: RevisionFragmentSelection = { articleId: 42, actionId: 'fragment:action-1', planDigest: digest('a'),
        basePackageDigest: digest('b'), comparePackageDigest: digest('c'), side: 'compare', sourceIdentity: 'revision:old:2',
        sourceDigest: compareDigest, packageDigest: digest('c'), chunkDigest: digest('f'), hunkIndex: 0, range: range(0, compare.length) };
    return { presentation, selection, source, compare };
}

describe('unexecuted exact historical fragment proposal', () => {
    it('preserves BOM, CRLF, CJK, emoji, trailing bytes and backward native selection without executing', async () => {
        const input = await fixture();
        const proposal = await createRevisionFragmentProposal(input.presentation, input.selection, current);
        expect(proposal.status).toBe('unexecuted');
        expect(proposal.fragmentText).toBe(input.source);
        expect(proposal.fragmentUtf8).toEqual(Array.from(input.compare));
        expect(new TextEncoder().encode(proposal.fragmentText)).toEqual(input.compare);
        expect(proposal.fragmentDigest).toBe(input.selection.sourceDigest);
        expect(proposal.current).toEqual(current());
        expect(proposal.historicalRevisionId).toBe('old');
        expect(proposal.executionRequirements).toContain('canonical-host-composition');
        expect(proposal.executionRequirements).toContain('current-permission-recheck');
        expect(proposal).not.toHaveProperty('permission');
        expect(proposal).not.toHaveProperty('transaction');
        expect(proposal).not.toHaveProperty('receipt');
        expect(Object.isFrozen(proposal.fragmentUtf8)).toBe(true);
        expect(Object.isFrozen(proposal.current.document)).toBe(true);
    });

    it('uses an exact UTF-8 subrange of the original hunk without HTML conversion', async () => {
        const input = await fixture('前\r\n<script>😀</script>  \r\n后');
        const text = '<script>😀</script>  \r\n';
        input.selection = { ...input.selection, range: range(new TextEncoder().encode('前\r\n').length, new TextEncoder().encode(text).length) };
        const proposal = await createRevisionFragmentProposal(input.presentation, input.selection, current);
        expect(proposal.fragmentText).toBe(text);
        expect(proposal.fragmentDigest).toBe(await revisionSourceDigest(new TextEncoder().encode(text)));
    });

    it.each(['planDigest', 'basePackageDigest', 'comparePackageDigest', 'sourceIdentity', 'sourceDigest', 'packageDigest', 'chunkDigest'] as const)(
        'rejects mismatched %s instead of matching similar text', async key => {
            const input = await fixture();
            const selected = { ...input.selection, [key]: key === 'sourceIdentity' ? 'revision:other:2' : digest('9') };
            await expect(createRevisionFragmentProposal(input.presentation, selected, current)).rejects.toThrow();
        });

    it('rejects another article, invalid action ID and invalid current context', async () => {
        const input = await fixture();
        await expect(createRevisionFragmentProposal(input.presentation, { ...input.selection, articleId: 43 }, current)).rejects.toThrow('current_context_invalid');
        await expect(createRevisionFragmentProposal(input.presentation, { ...input.selection, actionId: '' }, current)).rejects.toThrow('selection_invalid');
        for (const actionId of [undefined, null, 123, {}]) {
            await expect(createRevisionFragmentProposal(input.presentation,
                { ...input.selection, actionId } as unknown as RevisionFragmentSelection, current)).rejects.toThrow('selection_invalid');
        }
        await expect(createRevisionFragmentProposal(input.presentation, input.selection,
            () => ({ ...current(), document: { ...current().document, sourceRevision: 9 } }))).rejects.toThrow('current_context_invalid');
    });

    it.each([{ documentId: 'document:other' }, { documentEpoch: 4 }, { sourceRevision: 8 }, { content: 'edited' },
        { editorSessionId: 'session:other' }, { siteScope: 'site:other' }, { userScope: 'user:other' }])(
        'rejects document drift during hashing: %j', async changes => {
            const input = await fixture();
            let captures = 0;
            await expect(createRevisionFragmentProposal(input.presentation, input.selection,
                () => ++captures === 1 ? current() : current(changes))).rejects.toThrow('current_stale');
        });

    it.each([{ start: 4, end: 5, direction: 'backward' }, { start: 3, end: 5, direction: 'forward' }])(
        'rejects actual selection or direction drift: %j', async selection => {
            const input = await fixture();
            let captures = 0;
            await expect(createRevisionFragmentProposal(input.presentation, input.selection,
                () => ++captures === 1 ? current() : { ...current(), selection } as RevisionFragmentCurrentSnapshot)).rejects.toThrow('current_stale');
        });

    it('rejects mutable package, bytes and action request drift while hashing', async () => {
        for (const mutate of ['package', 'bytes', 'action']) {
            const input = await fixture();
            let captures = 0;
            await expect(createRevisionFragmentProposal(input.presentation, input.selection, () => {
                if (++captures === 2) {
                    if (mutate === 'package') input.presentation.response.planReceipt.comparePackageDigest = digest('9');
                    if (mutate === 'bytes') input.presentation.compareBytes[0] ^= 1;
                    if (mutate === 'action') input.selection = Object.assign(input.selection, { actionId: 'fragment:other' });
                }
                return current();
            })).rejects.toThrow('source_stale');
        }
    });

    it('rejects ranges outside the chosen hunk, empty ranges and absent or ambiguous hunks', async () => {
        const input = await fixture();
        input.presentation.response.sourceDiff.chunks[0].hunks[0].compare = range(3, input.compare.length - 3);
        await expect(createRevisionFragmentProposal(input.presentation, input.selection, current)).rejects.toThrow('range_outside_hunk');
        await expect(createRevisionFragmentProposal(input.presentation, { ...input.selection, range: range(3, 0) }, current)).rejects.toThrow('range_outside_hunk');
        await expect(createRevisionFragmentProposal(input.presentation, { ...input.selection, hunkIndex: 9 }, current)).rejects.toThrow('hunk_invalid');
        input.presentation.response.sourceDiff.chunks.push(structuredClone(input.presentation.response.sourceDiff.chunks[0]));
        await expect(createRevisionFragmentProposal(input.presentation, input.selection, current)).rejects.toThrow('hunk_invalid');
    });

    it('rejects unchanged context hunks and current/live packages as historical fragments', async () => {
        const input = await fixture();
        input.presentation.response.sourceDiff.chunks[0].hunks[0].kind = 0;
        await expect(createRevisionFragmentProposal(input.presentation, input.selection, current)).rejects.toThrow('hunk_invalid');
        input.presentation.response.sourceDiff.chunks[0].hunks[0].kind = 3;
        input.presentation.response.planReceipt.comparePackageReference.sourceKind = 2;
        await expect(createRevisionFragmentProposal(input.presentation, input.selection, current)).rejects.toThrow('historical_package_invalid');
    });

    it('can select the base side only when it is an exact historical package', async () => {
        const input = await fixture();
        const reference = input.presentation.response.planReceipt.basePackageReference;
        reference.sourceKind = 1;
        const proposal = await createRevisionFragmentProposal(input.presentation, { ...input.selection, side: 'base',
            packageDigest: reference.packageDigest, sourceIdentity: reference.sourceIdentity, sourceDigest: reference.sourceDigest,
            range: range(0, input.presentation.baseBytes.length) }, current);
        expect(proposal.fragmentText).toBe('current revision\n');
        expect(proposal.historicalRevisionId).toBe(reference.revisionId);
        expect(proposal.basePackageReference).toEqual(reference);
    });

    it.each([range(1, 2), range(0, 1), range(3, 3), { offset: 0, length: 3, end: 4 }])(
        'rejects partial UTF-8 or invalid range %j', async selectedRange => {
            const input = await fixture('中😀尾');
            await expect(createRevisionFragmentProposal(input.presentation, { ...input.selection, range: selectedRange }, current)).rejects.toThrow();
        });

    it('rejects malformed full source even when the selected fragment is valid', async () => {
        const input = await fixture('abc');
        input.presentation.compareBytes[2] = 0xff;
        const changedDigest = await revisionSourceDigest(input.presentation.compareBytes);
        input.presentation.response.planReceipt.comparePackageReference.sourceDigest = changedDigest;
        input.presentation.response.sourceDiff.receipt.compareSourceDigest = changedDigest;
        await expect(createRevisionFragmentProposal(input.presentation,
            { ...input.selection, sourceDigest: changedDigest, range: range(0, 1) }, current)).rejects.toThrow();
    });

    it('rejects byte, count and plan receipt drift without accepting stale fragments', async () => {
        for (const mutate of ['bytes', 'count', 'plan']) {
            const input = await fixture();
            if (mutate === 'bytes') input.presentation.compareBytes[0] ^= 1;
            if (mutate === 'count') input.presentation.response.sourceDiff.receipt.compareSourceByteCount++;
            if (mutate === 'plan') input.presentation.response.sourceDiff.receipt.planDigest = digest('9');
            await expect(createRevisionFragmentProposal(input.presentation, input.selection, current)).rejects.toThrow();
        }
    });

    it('repeated action preparation is deterministic and does not mutate the presentation or current document', async () => {
        const input = await fixture();
        const before = structuredClone(input.presentation);
        const first = await createRevisionFragmentProposal(input.presentation, input.selection, current);
        const second = await createRevisionFragmentProposal(input.presentation, input.selection, current);
        expect(second).toEqual(first);
        expect(input.presentation).toEqual(before);
        expect(current()).toEqual(first.current);
        // Execution deduplication belongs to the future canonical action owner, not this proposal.
    });

    it('cancels before preparation and during final native capture without producing a proposal', async () => {
        const input = await fixture();
        const controller = new AbortController();
        controller.abort();
        await expect(createRevisionFragmentProposal(input.presentation, input.selection, current, controller.signal)).rejects.toThrow();
        const late = new AbortController();
        let captures = 0;
        await expect(createRevisionFragmentProposal(input.presentation, input.selection, () => {
            if (++captures === 2) late.abort();
            return current();
        }, late.signal)).rejects.toThrow();
    });
});
