// @vitest-environment happy-dom
import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import type { MarkdownEditorInstance } from '@ozwasyd/element-plus';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, onUnmounted, ref } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { ArticleDocumentContextAuthority, inspectArticleDocumentEditorSessionAssociation } from '@/services/authoring/articleDocumentContext';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
const input = { articleId: 1, siteScope: 'primary-site', userScope: 'user:41', content: '# Loaded\n\nreal primary\n' };
const scope = { readPrincipalIdentityId: () => '41', readSiteScope: () => 'primary-site' };
async function fixture(canonical = false)
{
    const authority = new ArticleDocumentContextAuthority();
    // This is the same original acquire path as useAdminArticleWrite's private primary. The host only receives adapter/anchors.
    const primary = authority.acquire(input);
    const anchors = new ArticleAnchorContextAdapter(primary.adapter);
    const registry = new OpenArticleDocumentRegistry();
    const target = canonical ? new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input, scope).context : primary.adapter.context;
    expect(registry.openOrActivate({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
        commandId: 'open:primary', idempotencyKey: 'open:primary', expectedRevision: registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
        identity: { articleId: target.articleId, draftId: target.draftId, documentId: target.documentId },
        documentContext: { documentEpoch: target.documentEpoch, sourceRevision: `source-revision:${target.sourceRevision}`, draftRevision: target.draftRevision },
        editorSessionRef: 'native:primary', tabId: 'tab:primary', targetGroupId: 'group:primary', tabKind: 'pinned', lastActiveAnchorRef: null,
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:current' } }).status).toBe('applied');
    const entry = registry.getEntry('tab:primary')!;
    const controller = new AbortController();
    const identity = ref(primary.adapter.documentIdentity);
    const source = ref(input.content);
    const native = ref<MarkdownEditorInstance>();
    const wrapper = mount(defineComponent({ setup()
    {
        onUnmounted(() => controller.abort());
        return () => h(ElMarkdownEditor, { ref: native, modelValue: source.value, mode: 'source', documentIdentity: identity.value,
            'onUpdate:modelValue': (value: string) => { source.value = value; } });
    } }), { attachTo: document.body });
    cleanups.push(() => { wrapper.unmount(); anchors.dispose(); primary.release(); });
    await nextTick();
    const editor = native.value;
    if (!editor) throw new Error('actual-mounted-editor-missing');
    const admit = () => anchors.admitCurrentPrimaryRetainedDocument(authority, registry, entry, registry.getRevision(), scope, controller.signal);
    return { authority, primary, anchors, registry, entry, controller, target, editor, wrapper, admit,
        refreshNative: async () => { identity.value = primary.adapter.documentIdentity; await nextTick(); } };
}

describe('original bound Anchor retained admission and real native lifetime', () =>
{
    it('hands the exact original Anchor and genuine retained relation to the actual mounted public editor', async () =>
    {
        const f = await fixture();
        const before = f.primary.adapter.context;
        const loan = f.admit();
        expect(loan.anchors).toBe(f.anchors);
        expect(loan.binding.adapter).toBe(f.primary.adapter);
        expect(loan.binding.adapter.context).toBe(before);
        expect(loan.isCurrent()).toBe(true);
        const producer = loan.anchors.bindOwnedPositionProducer(loan.association, f.editor);
        expect(producer.binding()?.document).toBe(before);
        expect(inspectArticleDocumentEditorSessionAssociation(loan.association, loan.binding.adapter)?.handle).toBe(loan.binding.handle);
        expect(Object.isFrozen(loan)).toBe(true);
        expect(Object.keys(loan).sort()).toEqual(['anchors', 'association', 'binding', 'isCurrent', 'release', 'signal']);
    });
    it('canonicalizes the real primary while preserving its bound Anchor, then requires the real native identity to refresh', async () =>
    {
        const f = await fixture(true);
        const before = f.primary.adapter.context;
        const actualSession = f.editor.getSession(f.entry.editorSessionRef);
        const loan = f.admit();
        expect(loan.anchors).toBe(f.anchors);
        expect(loan.binding.adapter.context.documentId).toBe(f.target.documentId);
        expect(loan.binding.adapter.context.editorSessionId).toBe(before.editorSessionId);
        await f.refreshNative();
        const producer = loan.anchors.bindOwnedPositionProducer(loan.association, f.editor);
        expect(f.editor.getSession(f.entry.editorSessionRef)).toBe(actualSession);
        expect(actualSession.inspectDocumentState().documentIdentity.id).toBe(f.target.documentId);
        expect(producer.binding()?.document).toBe(f.primary.adapter.context);
    });
    it('refuses an old actual native identity after canonical handover', async () =>
    {
        const f = await fixture(true); const loan = f.admit();
        expect(() => loan.anchors.bindOwnedPositionProducer(loan.association, f.editor)).toThrow();
    });
    it('keeps admission and original maps live through a real controlled source revision and Registry activation', async () =>
    {
        const f = await fixture(); const loan = f.admit();
        const producer = loan.anchors.bindOwnedPositionProducer(loan.association, f.editor);
        const result = producer.dispatch({ changes: [{ from: 0, to: 0, insert: '!' }], expectedRevision: 0,
            documentIdentity: f.primary.adapter.documentIdentity, origin: 'programmatic', history: 'separate' });
        expect(result.accepted).toBe(true);
        f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'activate', commandId: 'activate:next',
            idempotencyKey: 'activate:next', expectedRevision: f.registry.getRevision(), tabId: f.entry.tabId, lastActiveAnchorRef: null });
        expect(loan.signal.aborted).toBe(false);
        expect(loan.isCurrent()).toBe(true);
        expect(producer.binding()?.document.sourceRevision).toBe(1);
        expect(f.registry.getEntry(f.entry.tabId)?.documentContext.sourceRevision).toBe('source-revision:0');
    });
    it.each(['caller-abort', 'native-unmount', 'explicit-release', 'anchor-dispose'] as const)('revokes the actual mount loan on %s without settling retained work', async kind =>
    {
        const f = await fixture(); const loan = f.admit();
        const pending = f.primary.adapter.beginTask('attachment', 'actual:retained-work');
        const producer = loan.anchors.bindOwnedPositionProducer(loan.association, f.editor);
        if (kind === 'caller-abort') f.controller.abort();
        if (kind === 'native-unmount') f.wrapper.unmount();
        if (kind === 'explicit-release') loan.release();
        if (kind === 'anchor-dispose') f.anchors.dispose();
        expect(loan.signal.aborted).toBe(true); expect(loan.isCurrent()).toBe(false);
        expect(producer.binding()).toBeNull();
        expect(pending.signal.aborted).toBe(false);
        expect(loan.binding.inspect().pendingTaskRefs).toContain(pending.taskRef);
        expect(loan.binding.inspect().admissionClosed).toBe(false);
        loan.release(); pending.cancel('actual-producer-stopped'); pending.settle();
    });
    it('revokes on actual original scope retirement and preserves canceled producer work until settlement', async () =>
    {
        const f = await fixture(); const loan = f.admit();
        const pending = f.primary.adapter.beginTask('render', 'actual:retired-work');
        f.authority.revokeRetainedScope('primary-site', '41');
        expect(loan.signal.aborted).toBe(true); expect(loan.isCurrent()).toBe(false);
        expect(pending.signal.aborted).toBe(true);
        expect(loan.binding.inspect().pendingTaskRefs).toContain(pending.taskRef);
        pending.settle();
    });
    it('final close and identical ID reconstruction never revive the old loan', async () =>
    {
        const f = await fixture(); const loan = f.admit();
        const result = f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'request-close', commandId: 'close:primary',
            idempotencyKey: 'close:primary', expectedRevision: f.registry.getRevision(), tabId: f.entry.tabId });
        expect(result.status).toBe('applied');
        expect(f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'detach-on-final-close', commandId: 'detach:primary',
            idempotencyKey: 'detach:primary', expectedRevision: f.registry.getRevision(), tabId: f.entry.tabId,
            closeDecisionRef: 'decision:actual-close' }).status).toBe('applied');
        expect(f.registry.getEntry(f.entry.tabId)).toBeNull();
        expect(f.registry.openOrActivate({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
            commandId: 'reopen:primary', idempotencyKey: 'reopen:primary', expectedRevision: f.registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
            identity: f.entry.identity, documentContext: f.entry.documentContext, editorSessionRef: f.entry.editorSessionRef,
            tabId: f.entry.tabId, targetGroupId: f.entry.owningGroupId, tabKind: 'pinned', lastActiveAnchorRef: null, status: f.entry.status }).status).toBe('applied');
        expect(loan.signal.aborted).toBe(true); expect(loan.isCurrent()).toBe(false);
        expect(inspectArticleDocumentEditorSessionAssociation(loan.association, loan.binding.adapter)).toBeNull();
    });
    it('refuses a second handoff from the same Anchor issuer', async () =>
    {
        const f = await fixture(); f.admit(); expect(() => f.admit()).toThrow('admission-unavailable');
    });
});
