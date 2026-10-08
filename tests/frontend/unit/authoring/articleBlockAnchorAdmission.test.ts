import { describe, expect, it, vi } from 'vitest';

import {
    createMarkdownEditorProjection,
    stabilizeMarkdownEditorProjection
} from '@ozwasyd/element-plus/markdown-runtime';

import type { MarkdownEditorCommandContext } from '@/fsusui/articleBlockAnchors';
import {
    resolveArticleBlockAnchorAdmission,
    verifyArticleBlockAnchorAdmission
} from '@/services/authoring/articleBlockAnchorAdmission';
import { createArticleDocumentContext, createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from '@/services/authoring/openArticleDocumentRegistry';

function fixture(source = 'Paragraph ^intro', kind = 'anchor')
{
    const owner = createArticleDocumentContextAdapter({
        articleId: 1,
        draftId: 'article:1',
        editorSessionId: 'editor:test',
        siteScope: 'site:test',
        userScope: 'user:test',
        content: source
    });
    // The public context factory also supports caller-supplied opaque IDs.
    const document = createArticleDocumentContext({ ...owner.context, documentId: 'matrix-document' });
    const identity = { id: document.documentId, epoch: document.documentEpoch };
    const projection = stabilizeMarkdownEditorProjection(
        createMarkdownEditorProjection(source), identity
    );
    const node = projection.nodes.find(item => item.kind === kind);
    if (!node)
    {
        throw new Error(`Public projection omitted fixture kind ${kind}.`);
    }
    const controller = new AbortController();
    const dispatch = vi.fn(() => { throw new Error('Admission must never dispatch.'); });
    const command: MarkdownEditorCommandContext = {
        value: source,
        projection,
        documentIdentity: identity,
        revision: owner.context.sourceRevision,
        readonly: false,
        mode: 'source',
        selection: { start: node.rawRange.start, end: node.rawRange.end, direction: 'backward' },
        signal: controller.signal,
        dispatch: { dispatch },
        syntax: {
            nodeId: node.id,
            blockIdentity: node.blockIdentity,
            range: node.rawRange,
            contentRanges: node.rawContentRanges,
            markerRanges: node.rawMarkerRanges,
            status: node.status,
            type: node.kind,
            diagnosticCode: node.diagnosticCode
        }
    };
    return { owner, document, command, controller, dispatch };
}

describe('Block anchor local admission (#2444)', () =>
{
    it('uses actual public projection identities and preserves source and backward selection', () =>
    {
        const { owner, document, command, dispatch } = fixture('\uFEFFParagraph ^intro\r\n\r\nTail  ');
        const before = document;
        const result = resolveArticleBlockAnchorAdmission(document, command, 'reveal-source');
        expect(result.status).toBe('admitted');
        expect(result.anchorId).toBe('intro');
        expect(result.range).toEqual(command.syntax?.range);
        expect(result.nodeId).toBe(command.syntax?.nodeId);
        expect(result.document).toBe(before);
        expect(owner.context.sourceRevision).toBe(before.sourceRevision);
        expect(command.selection.direction).toBe('backward');
        expect(command.value).toBe('\uFEFFParagraph ^intro\r\n\r\nTail  ');
        expect(dispatch).not.toHaveBeenCalled();
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.range)).toBe(true);
    });

    it('retains the former double-separator bytes as a canonical placement denial', () =>
    {
        const source = '\uFEFFParagraph  ^intro\r\n\r\nTail  ';
        const { owner, document, command, dispatch } = fixture(source, 'paragraph');
        const result = resolveArticleBlockAnchorAdmission(document, command, 'create', 'safe');
        expect(result.status).toBe('blocked');
        expect(result.reason).toBe('anchor-diagnostic');
        expect(result.diagnostic).toEqual({ code: 'anchor-placement', range: { start: 12, end: 18 } });
        expect(command.projection!.nodes.filter(node => node.kind === 'anchor' && node.status === 'valid')).toEqual([]);
        expect(result.anchorId).toBeNull();
        expect(result.document).toBe(document);
        expect(owner.context.sourceRevision).toBe(document.sourceRevision);
        expect(command.selection.direction).toBe('backward');
        expect(command.value).toBe(source);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it.each(['intro', 'a', 'a' + '9'.repeat(63), 'a-', 'section-42'])('admits exact candidate %s without writing source', candidate =>
    {
        const { owner, document, command, dispatch } = fixture('Paragraph', 'paragraph');
        const result = resolveArticleBlockAnchorAdmission(document, command, 'create', candidate);
        expect(result.status).toBe('admitted');
        expect(result.candidateId).toBe(candidate);
        expect(result.anchorId).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
        expect(owner.context.sourceRevision).toBe(0);
    });

    it.each(['', 'Intro', ' intro', 'intro ', '^intro', '1intro', 'intro_name', '章节', '%69ntro', 'a'.repeat(65), 'intro\n', 'intro\r\n'])('rejects candidate %j without normalization or suffixes', candidate =>
    {
        const { document, command } = fixture('Paragraph', 'paragraph');
        expect(resolveArticleBlockAnchorAdmission(document, command, 'create', candidate).reason)
            .toBe('anchor-id-invalid');
    });

    it('requires explicit input and rejects an existing ID instead of adding a suffix', () =>
    {
        const { document, command } = fixture('First ^intro\n\nSecond', 'paragraph');
        expect(resolveArticleBlockAnchorAdmission(document, command, 'create').reason).toBe('anchor-id-invalid');
        expect(resolveArticleBlockAnchorAdmission(document, command, 'create', 'intro').reason).toBe('anchor-id-duplicate');
    });

    it.each(['rename', 'request-remove'] as const)('requires real current impact before %s even with no visible local references', action =>
    {
        const { document, command, dispatch } = fixture();
        const result = resolveArticleBlockAnchorAdmission(document, command, action, action === 'rename' ? 'next' : undefined);
        expect(result.status).toBe('impact-required');
        expect(result.reason).toBe('current-impact-required');
        expect(result.anchorId).toBe('intro');
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('does not select the first valid occurrence in a duplicate document', () =>
    {
        const { document, command } = fixture('First ^intro\n\nSecond ^intro');
        const result = resolveArticleBlockAnchorAdmission(document, command, 'reveal-source');
        expect(result.reason).toBe('anchor-diagnostic');
        expect(result.anchorId).toBeNull();
        expect(result.diagnostic?.code).toBe('anchor-duplicate');
        expect(result.diagnostic?.range.start).toBeGreaterThan(command.syntax!.range.start);
    });

    it.each([
        ['First ^intro\n\nSecond ^Intro', 'anchor-invalid-id'],
        ['First ^intro\n\n^orphan', 'anchor-cross-gap'],
        ['^orphan\n\nFirst ^intro', 'anchor-orphan']
    ])('retains structured public diagnostic for %j', (source, code) =>
    {
        const { document, command } = fixture(source);
        const result = resolveArticleBlockAnchorAdmission(document, command, 'request-remove');
        expect(result.reason).toBe('anchor-diagnostic');
        expect(result.diagnostic?.code).toBe(code);
        expect(result.diagnostic).not.toHaveProperty('message');
        expect(JSON.stringify(result)).not.toContain(source);
    });

    it('isolates the same anchor ID in different articles', () =>
    {
        const first = fixture();
        const second = fixture();
        second.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: first.command.value });
        const result = resolveArticleBlockAnchorAdmission(second.owner.context, first.command, 'reveal-source');
        expect(result.reason).toBe('document-stale');
        expect(result.anchorId).toBeNull();
        expect(result.nodeId).toBeNull();
        expect(result.range).toBeNull();
    });

    it('rejects same-source article switch and stale results after edit followed by undo', () =>
    {
        const { owner, document, command } = fixture();
        const receipt = resolveArticleBlockAnchorAdmission(document, command, 'reveal-source');
        owner.updateSource('Changed ^intro');
        owner.updateSource(command.value);
        expect(resolveArticleBlockAnchorAdmission(owner.context, command, 'reveal-source').reason).toBe('document-stale');
        expect(verifyArticleBlockAnchorAdmission(receipt, owner.context, command)).toBe(false);
        owner.switchDocument({ articleId: 2, draftId: 'article:2', content: command.value });
        expect(resolveArticleBlockAnchorAdmission(owner.context, command, 'reveal-source').reason).toBe('document-stale');
    });

    it('rejects changed bytes even if the caller supplies the current revision', () =>
    {
        const { document, command } = fixture();
        expect(resolveArticleBlockAnchorAdmission(document, { ...command, value: 'Different ^intro' }, 'reveal-source').reason)
            .toBe('document-stale');
    });

    it('rejects cancellation without exposing an old source range', () =>
    {
        const { document, command, controller } = fixture();
        controller.abort();
        const result = resolveArticleBlockAnchorAdmission(document, command, 'reveal-source');
        expect(result.reason).toBe('command-aborted');
        expect(result.range).toBeNull();
        expect(result.nodeId).toBeNull();
    });

    it('permits read-only source reveal but blocks source action admission', () =>
    {
        const { document, command } = fixture();
        const readonly = { ...command, readonly: true };
        expect(resolveArticleBlockAnchorAdmission(document, readonly, 'reveal-source').status).toBe('admitted');
        expect(resolveArticleBlockAnchorAdmission(document, readonly, 'rename', 'next').reason).toBe('editor-readonly');
        expect(resolveArticleBlockAnchorAdmission(document, readonly, 'request-remove').reason).toBe('editor-readonly');
    });

    it('rejects missing and foreign-epoch projections instead of guessing a node', () =>
    {
        const { document, command } = fixture();
        expect(resolveArticleBlockAnchorAdmission(document, { ...command, projection: undefined }, 'reveal-source').reason)
            .toBe('projection-unavailable');
        const foreign = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection(command.value), { id: 'foreign', epoch: 9 });
        expect(resolveArticleBlockAnchorAdmission(document, { ...command, projection: foreign }, 'reveal-source').reason)
            .toBe('projection-stale');
    });

    it('rejects stale projection bytes and missing syntax', () =>
    {
        const { document, command } = fixture();
        const stale = stabilizeMarkdownEditorProjection(createMarkdownEditorProjection('Changed ^intro'), command.documentIdentity);
        expect(resolveArticleBlockAnchorAdmission(document, { ...command, projection: stale }, 'reveal-source').reason)
            .toBe('projection-stale');
        expect(resolveArticleBlockAnchorAdmission(document, { ...command, syntax: undefined }, 'reveal-source').reason)
            .toBe('source-node-unavailable');
    });

    it.each(['nodeId', 'blockIdentity', 'type', 'range'] as const)('rejects tampered syntax %s', field =>
    {
        const { document, command } = fixture();
        const syntax = { ...command.syntax!, [field]: field === 'range' ? { start: 0, end: 1 } : 'foreign' };
        expect(resolveArticleBlockAnchorAdmission(document, { ...command, syntax }, 'reveal-source').reason).toBe('source-node-stale');
    });

    it('requires an existing explicit anchor for rename/remove/reveal and blocks creation on an anchor', () =>
    {
        const text = fixture('Paragraph', 'paragraph');
        for (const action of ['rename', 'request-remove', 'reveal-source'] as const)
        {
            expect(resolveArticleBlockAnchorAdmission(text.document, text.command, action, 'next').reason).toBe('anchor-required');
        }
        const anchor = fixture();
        expect(resolveArticleBlockAnchorAdmission(anchor.document, anchor.command, 'create', 'next').reason).toBe('anchor-already-present');
        expect(resolveArticleBlockAnchorAdmission(anchor.document, anchor.command, 'rename', 'intro').reason).toBe('anchor-id-duplicate');
    });

    it('recomputes current facts to reject receipt tamper, including a self-consistent digest', () =>
    {
        const { document, command } = fixture();
        const receipt = resolveArticleBlockAnchorAdmission(document, command, 'request-remove');
        expect(verifyArticleBlockAnchorAdmission(receipt, document, command)).toBe(true);
        const body = { ...receipt, status: 'admitted' as const, reason: null };
        const { contentDigest: ignored, ...unsigned } = body;
        void ignored;
        const resealed = { ...unsigned, contentDigest: calculateOpenArticleDocumentDigest(unsigned) };
        expect(verifyArticleBlockAnchorAdmission(resealed, document, command)).toBe(false);
        expect(verifyArticleBlockAnchorAdmission({ ...receipt, anchorId: 'other' }, document, command)).toBe(false);
    });
});
