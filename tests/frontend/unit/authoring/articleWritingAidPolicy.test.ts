import {
    createWritingAidsController,
    resolveWritingAids
} from '@ozwasyd/element-plus';
import { describe, expect, it } from 'vitest';

import {
    createArticleDocumentContext,
    createArticleDocumentContextAdapter
} from '@/services/authoring/articleDocumentContext';
import {
    resolveArticleWritingAidPolicy,
    type ArticleWritingAidPolicyInput
} from '@/services/authoring/articleWritingAidPolicy';

function fixture(): ArticleWritingAidPolicyInput
{
    const documentOwner = createArticleDocumentContextAdapter({
        articleId: 1,
        draftId: 'article:1',
        editorSessionId: 'session:test',
        siteScope: 'site:test',
        userScope: 'user:test',
        content: '# private source'
    });
    return {
        requested: { focus: true, typewriter: true },
        document: documentOwner.context,
        documentOwner,
        editablePane: true,
        readonly: false,
        focusAvailable: true,
        typewriterAvailable: true,
        overlayActive: false,
        composing: false,
        selectionDragging: false,
        assistiveNavigation: false,
        manualScrollActive: false,
        explicitNavigationActive: false,
        viewportAvailable: true
    };
}

describe('article writing-aid public prop policy (#2287)', () =>
{
    it.each([
        [false, false], [false, true], [true, false], [true, true]
    ])('keeps Focus=%s and Typewriter=%s independent', (focus, typewriter) =>
    {
        const input = fixture();
        const requested = Object.freeze({ focus, typewriter });
        const before = JSON.stringify(input.document);
        const result = resolveArticleWritingAidPolicy({ ...input, requested });
        expect(result.focus).toEqual({
            requested: focus, effective: focus, blockedReason: focus ? null : 'not-requested'
        });
        expect(result.typewriter).toEqual({
            requested: typewriter, effective: typewriter, blockedReason: typewriter ? null : 'not-requested'
        });
        expect(resolveWritingAids(result.editorProps.writingAids)).toEqual({
            focus, typewriter, typewriterAnchor: 'upper-third'
        });
        expect(requested).toEqual({ focus, typewriter });
        expect(JSON.stringify(input.document)).toBe(before);
        expect(Object.keys(result.editorProps).sort()).toEqual(['focusExemptions', 'writingAids']);
    });

    it('does not consult document owners or create runtime options when disabled', () =>
    {
        const result = resolveArticleWritingAidPolicy({
            ...fixture(),
            requested: { focus: false, typewriter: false },
            document: null,
            documentOwner: { isCurrentContext: () => { throw new Error('unexpected owner read'); } }
        });
        expect(result.editorProps.writingAids).toBeUndefined();
        expect(result.focus.blockedReason).toBe('not-requested');
        expect(result.typewriter.blockedReason).toBe('not-requested');
    });

    it('keeps unavailable preferences distinct from a deliberate off request', () =>
    {
        const result = resolveArticleWritingAidPolicy({ ...fixture(), requested: null });
        expect(result.focus.blockedReason).toBe('preference-unavailable');
        expect(result.typewriter.blockedReason).toBe('preference-unavailable');
        expect(result.editorProps.writingAids).toBeUndefined();
    });

    it.each([
        ['editablePane', false, 'inactive-pane'],
        ['readonly', true, 'read-only'],
        ['overlayActive', true, 'overlay'],
        ['composing', true, 'composition'],
        ['selectionDragging', true, 'selection-drag'],
        ['assistiveNavigation', true, 'assistive-navigation']
    ] as const)('yields both aids for %s and recovers without changing requests', (key, value, reason) =>
    {
        const input = fixture();
        const result = resolveArticleWritingAidPolicy({ ...input, [key]: value });
        expect(result.focus).toEqual({ requested: true, effective: false, blockedReason: reason });
        expect(result.typewriter).toEqual({ requested: true, effective: false, blockedReason: reason });
        expect(result.editorProps.writingAids).toBeUndefined();
        const recovered = resolveArticleWritingAidPolicy(input);
        expect(recovered.focus.effective).toBe(true);
        expect(recovered.typewriter.effective).toBe(true);
        expect(input.requested).toEqual({ focus: true, typewriter: true });
    });

    it.each([
        ['manualScrollActive', true, 'manual-scroll'],
        ['explicitNavigationActive', true, 'explicit-navigation'],
        ['viewportAvailable', false, 'viewport-unavailable'],
        ['typewriterAvailable', false, 'capability-unavailable']
    ] as const)('blocks only Typewriter for %s', (key, value, reason) =>
    {
        const input = fixture();
        const result = resolveArticleWritingAidPolicy({ ...input, [key]: value });
        expect(result.focus.effective).toBe(true);
        expect(result.typewriter).toEqual({ requested: true, effective: false, blockedReason: reason });
        expect(result.editorProps.writingAids?.focus).toBe(true);
        expect(result.editorProps.writingAids?.typewriter).toBe(false);
        expect(resolveArticleWritingAidPolicy(input).typewriter.effective).toBe(true);
    });

    it('blocks only Focus when its public runtime is unavailable', () =>
    {
        const result = resolveArticleWritingAidPolicy({ ...fixture(), focusAvailable: false });
        expect(result.focus.blockedReason).toBe('capability-unavailable');
        expect(result.typewriter.effective).toBe(true);
    });

    it('passes public exemptions unchanged and leaves anchor defaults with FsusUI', () =>
    {
        const input = fixture();
        const focusExemptions = Object.freeze({
            pendingAttachmentIds: ['attachment:test'],
            diagnostics: ['diagnostic:test'],
            screenReaderBrowseTargetId: 'node:test'
        });
        const result = resolveArticleWritingAidPolicy({
            ...input,
            focusExemptions
        });
        expect(result.editorProps.focusExemptions).toBe(focusExemptions);
        expect(result.editorProps.writingAids?.typewriterAnchor).toBeUndefined();
        expect(resolveWritingAids(result.editorProps.writingAids).typewriterAnchor).toBe('upper-third');
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.editorProps.writingAids)).toBe(true);
    });

    it.each(['articleId', 'documentEpoch', 'sourceRevision', 'userScope', 'siteScope'] as const)(
        'rejects valid but foreign %s even when content bytes match', (key) =>
        {
            const input = fixture();
            const original = input.document!;
            const document = createArticleDocumentContext({
                ...original,
                [key]: typeof original[key] === 'number' ? Number(original[key]) + 1 : 'scope:other'
            });
            expect(document.contentDigest).toBe(original.contentDigest);
            const result = resolveArticleWritingAidPolicy({ ...input, document });
            expect(result.focus.blockedReason).toBe('stale-document');
            expect(result.typewriter.blockedReason).toBe('stale-document');
            expect(result.editorProps.writingAids).toBeUndefined();
        }
    );

    it('rejects tampered context through the original validator', () =>
    {
        const input = fixture();
        const result = resolveArticleWritingAidPolicy({
            ...input, document: { ...input.document!, contextDigest: '0'.repeat(64) }
        });
        expect(result.focus.blockedReason).toBe('document-unavailable');
        expect(result.typewriter.blockedReason).toBe('document-unavailable');
    });

    it('does not return source, document identities or article state in public props', () =>
    {
        const result = resolveArticleWritingAidPolicy(fixture());
        expect(JSON.stringify(result)).not.toMatch(/private source|articleId|documentEpoch|userScope|siteScope/);
    });

    it('consumes the real public runtime for manual scroll, selection, IME and epoch changes', () =>
    {
        const result = resolveArticleWritingAidPolicy(fixture());
        const runtime = createWritingAidsController(result.editorProps.writingAids);
        expect(runtime.options).toEqual({ focus: true, typewriter: true, typewriterAnchor: 'upper-third' });
        expect(runtime.handleUserScroll().scroll).toBe(false);
        expect(runtime.state).toBe('user-scroll-suspended');
        expect(runtime.handleAsyncLayoutChange().scroll).toBe(false);
        expect(runtime.handleSelectionChange().scroll).toBe(false);
        expect(runtime.handleInput().scroll).toBe(false);
        expect(runtime.handleInput().scroll).toBe(true);
        expect(runtime.handleCompositionStart().scroll).toBe(false);
        expect(runtime.handleAsyncLayoutChange().scroll).toBe(false);
        expect(runtime.handleCompositionEnd().scroll).toBe(false);
        runtime.updateDocument({ documentIdentity: 'document:next', documentEpoch: 2 });
        expect(runtime.state).toBe('idle');
        expect(runtime.currentBlock).toBeNull();
        expect(runtime.handleAsyncLayoutChange().scroll).toBe(false);
    });
});
