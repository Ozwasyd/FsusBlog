// @vitest-environment happy-dom
import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';

import * as anchors from '@/services/authoring/articleAnchorContext';
import { ArticleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

import type { MarkdownEditorTransaction } from '@ozwasyd/element-plus';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()));
const options = { affinity: 'after' as const, viewportOffset: 0, percentage: 0, surface: 'source' as const, tool: 'none' as const };

async function fixture()
{
    const source = '# Heading\n\nabcdef\n';
    const authority = new ArticleDocumentContextAuthority();
    const registry = new OpenArticleDocumentRegistry();
    const prepared = authority.prepareRetainedDocument(registry, { articleId: 1, siteScope: 'site:test', userScope: 'user:41', content: source },
        { readPrincipalIdentityId: () => '41', readSiteScope: () => 'site:test' });
    const context = prepared.context;
    const tabId = 'tab:position';
    const sessionRef = 'session:original-native';
    expect(registry.openOrActivate({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
        commandId: 'position:open', idempotencyKey: 'position:open', expectedRevision: registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
        identity: { articleId: context.articleId, draftId: context.draftId, documentId: context.documentId },
        documentContext: { documentEpoch: context.documentEpoch, sourceRevision: `source-revision:${context.sourceRevision}`, draftRevision: context.draftRevision },
        editorSessionRef: sessionRef, tabId, targetGroupId: 'group:main', tabKind: 'pinned', lastActiveAnchorRef: null,
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:current' } }).status).toBe('applied');
    const retained = authority.acquireRetainedDocument(registry.issueRetainedDocumentHandle(tabId), prepared);
    const owner = retained.adapter;
    const wrapper = mount(ElMarkdownEditor, { attachTo: document.body, props: { modelValue: source, mode: 'source', documentIdentity: owner.documentIdentity } });
    let unmounted = false;
    const unmount = () => { if (!unmounted) { unmounted = true; wrapper.unmount(); } };
    cleanup.push(unmount);
    await nextTick();
    const editor = wrapper.vm as unknown as anchors.ArticleAnchorNativeEditorPort;
    const anchorOwner = new anchors.ArticleAnchorContextAdapter(owner);
    const association = authority.issueEditorSessionAssociation(retained)!;
    const producer = anchorOwner.bindOwnedPositionProducer(association, editor);
    cleanup.push(() => { producer.dispose(); anchorOwner.dispose(); });
    const dispatch = (changes: MarkdownEditorTransaction['changes']) => producer.dispatch({ changes, documentIdentity: owner.documentIdentity,
        expectedRevision: owner.context.sourceRevision, origin: 'programmatic', history: 'separate' });
    return { authority, registry, retained, owner, wrapper, editor, anchorOwner, association, producer, dispatch, unmount,
        capture: (start = 11, end = 15) => anchorOwner.capture(producer.binding()!, { start, end, direction: 'forward' }, options) };
}

describe('original Anchor bounded capture and real native position producer', () =>
{
    it('resolves the exact original full capture from its node-bound reference without a context cast', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        const reference = anchors.createArticleAnchorCaptureReference(saved);
        expect(f.anchorOwner.resolveOwnedCapture(reference)).toBe(saved);
        expect(f.producer.resolveCapture(reference)).toBe(saved);
        expect(f.producer.transactions(saved)).toEqual([]);
        expect(f.producer.binding()?.document).toBe(f.owner.context);
        expect(f.owner.context.editorSessionId).not.toBe(f.registry.getEntry('tab:position')!.editorSessionRef);
    });

    it('records only actual controlled native dispatch results as a contiguous public mapping chain', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        const first = f.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        const second = f.dispatch([{ from: 0, to: 0, insert: 'Y' }]);
        expect(first.accepted && second.accepted).toBe(true);
        const transactions = f.producer.transactions(saved);
        expect(transactions).not.toBeNull();
        expect(transactions).toEqual([first, second]);
        expect(transactions![0]).toBe(first);
        expect(f.anchorOwner.restore(saved, f.producer.binding()!, { origin: 'outline', now: 100,
            viewportHeight: 500, reducedMotion: true, transactions: transactions! })).toMatchObject({ status: 'ready', kind: 'rebased' });
    });

    it('uses the native session selection for producer capture', async () =>
    {
        const f = await fixture();
        const saved = f.producer.capture(options);
        expect(saved).not.toBeNull();
        expect(f.producer.resolveCapture(anchors.createArticleAnchorCaptureReference(saved!))).toBe(saved);
    });

    it('records original native undo/redo maps in the same continuous producer chain', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        const edit = f.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        const undo = f.producer.undo();
        const redo = f.producer.redo();
        expect(edit.accepted && undo.accepted && redo.accepted).toBe(true);
        expect(f.producer.transactions(saved)).toEqual([edit, undo, redo]);
        expect(f.anchorOwner.restore(saved, f.producer.binding()!, { origin: 'outline', now: 100, viewportHeight: 500,
            reducedMotion: true, transactions: f.producer.transactions(saved)! })).toMatchObject({ status: 'ready', kind: 'rebased', rebase: ['mapped', 'mapped', 'mapped'] });
    });

    it('keeps partial deletion an original restore outcome', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        f.dispatch([{ from: 12, to: 14, insert: '' }]);
        expect(f.anchorOwner.restore(saved, f.producer.binding()!, { origin: 'outline', now: 100, viewportHeight: 500,
            reducedMotion: true, transactions: f.producer.transactions(saved)! })).toMatchObject({ status: 'ready', kind: 'partial' });
    });

    it('refuses cloned tokens, foreign captures and a second producer for the same owner', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        expect(f.producer.transactions({ ...saved })).toBeNull();
        expect(f.anchorOwner.resolveOwnedCapture({ ...anchors.createArticleAnchorCaptureReference(saved), anchorContextDigest: 'a'.repeat(64) })).toBeNull();
        expect(() => f.anchorOwner.bindOwnedPositionProducer({ ...f.association }, f.editor)).toThrow();
        expect(() => f.anchorOwner.bindOwnedPositionProducer(f.association, f.editor)).toThrow();
        const other = new anchors.ArticleAnchorContextAdapter(f.owner);
        expect(() => other.bindOwnedPositionProducer(f.association, f.editor)).toThrow();
    });

    it('bounds owned captures and rejects evicted references', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        const reference = anchors.createArticleAnchorCaptureReference(saved);
        for (let index = 1; index <= anchors.articleAnchorOwnershipPolicy.maxCaptures; index += 1)
            f.anchorOwner.capture(f.producer.binding()!, { start: 11, end: 15, direction: 'forward' }, { ...options, viewportOffset: index });
        expect(f.anchorOwner.resolveOwnedCapture(reference)).toBeNull();
        expect(f.anchorOwner.resolveOwnedCapture(anchors.createArticleAnchorCaptureReference(f.capture()))).not.toBeNull();
    });

    it('refuses a mapping gap after bounded native map retention', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        for (let index = 0; index <= anchors.articleAnchorOwnershipPolicy.maxTransactions; index += 1)
            expect(f.dispatch([{ from: 0, to: 0, insert: 'X' }]).accepted).toBe(true);
        expect(f.producer.transactions(saved)).toBeNull();
        const current = f.capture();
        expect(f.producer.transactions(current)).toEqual([]);
    });

    it.each(['anchor-dispose', 'producer-dispose', 'scope-retirement', 'native-unmount', 'epoch-drift'] as const)(
        'invalidates original capture and map loans on %s', async kind =>
        {
            const f = await fixture();
            const saved = f.capture();
            const reference = anchors.createArticleAnchorCaptureReference(saved);
            if (kind === 'anchor-dispose')
            {
                const binding = f.producer.binding()!;
                f.anchorOwner.dispose();
                expect(f.anchorOwner.isCurrentPositionBinding(binding)).toBe(false);
            }
            if (kind === 'producer-dispose') f.producer.dispose();
            if (kind === 'scope-retirement') f.authority.revokeRetainedScope('site:test', '41');
            if (kind === 'native-unmount') f.unmount();
            if (kind === 'epoch-drift') await f.wrapper.setProps({ documentIdentity: { ...f.owner.documentIdentity, epoch: f.owner.context.documentEpoch + 1 } });
            expect(f.producer.binding()).toBeNull();
            expect(f.producer.resolveCapture(reference)).toBeNull();
            expect(f.producer.transactions(saved)).toBeNull();
            expect(f.anchorOwner.resolveOwnedCapture(reference)).toBeNull();
        }
    );

    it('refuses out-of-band native dispatch even when Document is subsequently updated to matching text', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        const result = f.editor.dispatchTransaction({ changes: [{ from: 0, to: 0, insert: 'outside' }],
            documentIdentity: f.owner.documentIdentity, expectedRevision: f.owner.context.sourceRevision, origin: 'programmatic', history: 'separate' });
        expect(result.accepted).toBe(true);
        f.owner.updateSource(result.value, result.revision);
        expect(f.producer.transactions(saved)).toBeNull();
        expect(f.producer.binding()).toBeNull();
    });

    it('keeps actual native numeric revision 47 without parsing the Registry source reference', async () =>
    {
        const f = await fixture();
        for (let index = 0; index < 47; index += 1) f.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        expect(f.producer.binding()?.document.sourceRevision).toBe(47);
        expect(f.editor.getSession('session:original-native').inspectDocumentState().revision).toBe(47);
        expect(f.registry.getEntry('tab:position')!.documentContext.sourceRevision).toBe('source-revision:0');
    });

    it('refuses caller-mutated original dispatch metadata instead of accepting a forged map chain', async () =>
    {
        const f = await fixture();
        const saved = f.capture();
        const result = f.dispatch([{ from: 0, to: 0, insert: 'X' }]);
        try { Object.defineProperty(result, 'positionMap', { value: undefined }); } catch { /* Frozen native output is already protected. */ }
        const chain = f.producer.transactions(saved);
        if (chain !== null) expect(Object.isFrozen(result)).toBe(true);
        else expect(f.producer.binding()).toBeNull();
    });
});
