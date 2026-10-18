import { describe, expect, it } from 'vitest';
import { ArticleDocumentContextAuthority, createArticleDocumentContextAdapter, inspectArticleDocumentEditorSessionAssociation } from '@/services/authoring/articleDocumentContext';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';
import type { ArticleDocumentContext } from '@/services/authoring/articleDocumentContext';
const input = { articleId: 1, siteScope: 'primary-site', userScope: 'user:41', content: '# Loaded\n\nreal primary\n' };
const scope = { readPrincipalIdentityId: () => '41', readSiteScope: () => 'primary-site' };
function open(registry: OpenArticleDocumentRegistry, context: ArticleDocumentContext, commandId = 'open:primary')
{
    expect(registry.openOrActivate({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
        commandId, idempotencyKey: commandId, expectedRevision: registry.getRevision(), intent: 'workspace', entrypoint: 'direct-route',
        identity: { articleId: context.articleId, draftId: context.draftId, documentId: context.documentId },
        documentContext: { documentEpoch: context.documentEpoch, sourceRevision: `source-revision:${context.sourceRevision}`, draftRevision: context.draftRevision },
        editorSessionRef: 'native:primary', tabId: 'tab:primary', targetGroupId: 'group:primary', tabKind: 'pinned', lastActiveAnchorRef: null,
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:current' } }).status).toBe('applied');
    return registry.getEntry('tab:primary')!;
}
function fixture(canonical = false)
{
    const authority = new ArticleDocumentContextAuthority();
    const primary = authority.acquire(input);
    const registry = new OpenArticleDocumentRegistry();
    const target = canonical ? new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input, scope).context : primary.adapter.context;
    const entry = open(registry, target);
    const revision = registry.getRevision();
    const controller = new AbortController();
    const admit = (readers = scope, signal = controller.signal) => authority.admitCurrentPrimaryRetainedDocument(registry, entry, revision, primary.adapter, readers, signal);
    return { authority, primary, registry, target, entry, controller, admit };
}
describe('original private primary to retained admission producer', () =>
{
    it('resolves the actual sole private binding and keeps retained work alive after primary release', () =>
    {
        const f = fixture();
        const before = f.primary.adapter.context;
        const pending = f.primary.adapter.beginTask('render', 'actual:primary');
        const retained = f.admit();
        expect(retained.adapter).toBe(f.primary.adapter);
        expect(retained.adapter.context).toBe(before);
        expect(f.authority.acquireRetainedDocument(retained.handle)).toBe(retained);
        const association = f.authority.issueEditorSessionAssociation(retained)!;
        expect(inspectArticleDocumentEditorSessionAssociation(association, retained.adapter)?.registryEditorSessionRef).toBe(f.entry.editorSessionRef);
        expect(before.editorSessionId).not.toBe(f.entry.editorSessionRef);
        f.primary.release(); f.controller.abort();
        expect(pending.signal.aborted).toBe(false);
        expect(retained.inspect().admissionClosed).toBe(false);
        expect(pending.accept('actual-result').accepted).toBe(true);
    });
    it('uses original canonical publication and retains canceled work until real settlement', () =>
    {
        const f = fixture(true);
        const before = f.primary.adapter.context;
        const pending = f.primary.adapter.beginTask('attachment', 'actual:old-primary');
        const retained = f.admit();
        expect(retained.adapter).toBe(f.primary.adapter);
        expect(retained.adapter.context.documentId).toBe(f.target.documentId);
        expect(retained.adapter.context.editorSessionId).toBe(before.editorSessionId);
        expect(retained.adapter.context.contentDigest).toBe(before.contentDigest);
        expect(pending.signal.aborted).toBe(true);
        expect(pending.accept('late').accepted).toBe(false);
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
        pending.settle(); expect(retained.inspect().pendingTaskRefs).toEqual([]);
    });
    it('retries exact original custody without storing an aborted admission signal as a scope reader', () =>
    {
        const f = fixture(); const retained = f.admit(); f.controller.abort();
        expect(f.admit(scope, new AbortController().signal)).toBe(retained);
        expect(retained.inspect().admissionClosed).toBe(false);
    });
    it('finds the sole old binding after a later sibling releases', () =>
    {
        const f = fixture(); f.authority.acquire(input).release(); expect(f.admit().adapter).toBe(f.primary.adapter);
    });
    it.each(['released', 'multiple', 'foreign-authority', 'unowned-adapter'] as const)('refuses %s ownership without Registry writes', kind =>
    {
        const f = fixture(); const revision = f.registry.getRevision();
        if (kind === 'released') f.primary.release();
        if (kind === 'multiple') f.authority.acquire(input);
        expect(() => kind === 'foreign-authority'
            ? new ArticleDocumentContextAuthority().admitCurrentPrimaryRetainedDocument(f.registry, f.entry, f.registry.getRevision(), f.primary.adapter, scope, f.controller.signal)
            : kind === 'unowned-adapter'
                ? f.authority.admitCurrentPrimaryRetainedDocument(f.registry, f.entry, f.registry.getRevision(), createArticleDocumentContextAdapter({ ...input, draftId: 'article:1', editorSessionId: 'standalone:original' }), scope, f.controller.signal)
                : f.admit()).toThrow('owner-unavailable');
        expect(f.registry.getRevision()).toBe(revision);
    });
    it('does not create an absent Registry member or interpret absence as deletion', () =>
    {
        const f = fixture(); const empty = new OpenArticleDocumentRegistry();
        expect(() => f.authority.admitCurrentPrimaryRetainedDocument(empty, f.entry, empty.getRevision(), f.primary.adapter, scope, f.controller.signal)).toThrow('entry-changed');
        expect(empty.getRevision()).toBe(0);
    });
    it('refuses a stale entry observation after original activation', () =>
    {
        const f = fixture(); f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'activate', commandId: 'activate:next',
            idempotencyKey: 'activate:next', expectedRevision: f.registry.getRevision(), tabId: f.entry.tabId, lastActiveAnchorRef: 'anchor:next' });
        expect(f.registry.getEntry(f.entry.tabId)?.contentDigest).not.toBe(f.entry.contentDigest);
        expect(() => f.admit()).toThrow('entry-changed');
    });
    it.each(['principal', 'site'] as const)('refuses real %s scope mismatch', kind =>
    {
        const f = fixture(); const before = f.primary.adapter.context;
        expect(() => f.admit({ readPrincipalIdentityId: () => kind === 'principal' ? '42' : '41',
            readSiteScope: () => kind === 'site' ? 'other-site' : 'primary-site' })).toThrow('scope-invalid');
        expect(f.primary.adapter.context).toBe(before);
    });
    it('refuses native pre-abort and structural signals before any adoption', () =>
    {
        const f = fixture(); f.controller.abort(); expect(() => f.admit()).toThrow('aborted');
        expect(() => Reflect.apply(f.authority.admitCurrentPrimaryRetainedDocument, f.authority,
            [f.registry, f.entry, f.registry.getRevision(), f.primary.adapter, scope, { aborted: false }])).toThrow();
        expect(f.admit(scope, new AbortController().signal).adapter).toBe(f.primary.adapter);
    });
    it('refuses abort from a real scope callback before publication, then admits a fresh attempt', () =>
    {
        const f = fixture(); const before = f.primary.adapter.context;
        expect(() => f.admit({ readPrincipalIdentityId: () => { f.controller.abort(); return '41'; }, readSiteScope: scope.readSiteScope })).toThrow('aborted');
        expect(f.primary.adapter.context).toBe(before);
        expect(f.admit(scope, new AbortController().signal).adapter).toBe(f.primary.adapter);
    });
    it('refuses release of the actual primary inside a scope callback', () =>
    {
        const f = fixture();
        expect(() => f.admit({ readPrincipalIdentityId: () => { f.primary.release(); return '41'; }, readSiteScope: scope.readSiteScope })).toThrow('admission-changed');
    });
    it('guards canonical publication against cancellation from actual old-work abort callbacks', () =>
    {
        const f = fixture(true); const before = f.primary.adapter.context;
        const task = f.primary.adapter.beginTask('render', 'actual:abort-callback');
        task.signal.addEventListener('abort', () => f.controller.abort());
        expect(() => f.admit()).toThrow('aborted'); expect(f.primary.adapter.context).toBe(before); task.settle();
        expect(f.admit(scope, new AbortController().signal).adapter.context.documentId).toBe(f.target.documentId);
    });
    it('refuses production admission reentry from real scope reads', () =>
    {
        const f = fixture(); let calls = 0;
        expect(f.admit({ readPrincipalIdentityId: () => { calls += 1; expect(() => f.admit()).toThrow('in-progress'); return '41'; },
            readSiteScope: scope.readSiteScope }).adapter).toBe(f.primary.adapter);
        expect(calls).toBeGreaterThan(0);
    });
    it('rejects a stale observation after final close and exact same-ID Registry reconstruction', () =>
    {
        const f = fixture();
        expect(f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'request-close', commandId: 'close:primary',
            idempotencyKey: 'close:primary', expectedRevision: f.registry.getRevision(), tabId: f.entry.tabId }).status).toBe('applied');
        expect(f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'detach-on-final-close', commandId: 'detach:primary',
            idempotencyKey: 'detach:primary', expectedRevision: f.registry.getRevision(), tabId: f.entry.tabId, closeDecisionRef: 'decision:primary' }).status).toBe('applied');
        open(f.registry, f.primary.adapter.context, 'reopen:primary');
        expect(() => f.admit()).toThrow('entry-changed');
        const entry = f.registry.getEntry(f.entry.tabId)!;
        expect(f.authority.admitCurrentPrimaryRetainedDocument(f.registry, entry, f.registry.getRevision(), f.primary.adapter,
            scope, new AbortController().signal).adapter).toBe(f.primary.adapter);
    });
    it('does not publish retained ownership while original permission is blocked', () =>
    {
        const f = fixture();
        f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'invalidate-permission', commandId: 'permission:block',
            idempotencyKey: 'permission:block', expectedRevision: f.registry.getRevision(), tabId: f.entry.tabId,
            permission: 'denied', statusRef: 'status:denied' });
        const current = f.registry.getEntry(f.entry.tabId)!;
        expect(() => f.authority.admitCurrentPrimaryRetainedDocument(f.registry, current, f.registry.getRevision(), f.primary.adapter, scope, f.controller.signal)).toThrow();
    });
    it('refuses a changed actual Registry observation inside original scope readers', () =>
    {
        const f = fixture(); let changed = false;
        expect(() => f.admit({ readPrincipalIdentityId: () =>
        {
            if (!changed)
            {
                changed = true;
                f.registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'activate', commandId: 'activate:scope',
                    idempotencyKey: 'activate:scope', expectedRevision: f.registry.getRevision(), tabId: f.entry.tabId, lastActiveAnchorRef: 'anchor:scope' });
            }
            return '41';
        }, readSiteScope: scope.readSiteScope })).toThrow('admission-changed');
    });
    it('does not roll back real canonical publication after a cancellation from its actual context notification', () =>
    {
        const f = fixture(true);
        f.primary.adapter.subscribeContext(context => { if (context?.documentId === f.target.documentId) f.controller.abort(); });
        expect(() => f.admit()).toThrow('aborted');
        expect(f.primary.adapter.context.documentId).toBe(f.target.documentId);
        expect(f.primary.adapter.isCurrentContext(f.primary.adapter.context)).toBe(false);
        expect(() => f.admit(scope, new AbortController().signal)).toThrow();
    });
    it('refuses a numeric source gap instead of parsing the Registry reference', () =>
    {
        const f = fixture(true); f.primary.adapter.updateSource(`${input.content}!`, 7);
        expect(() => f.admit()).toThrow('source-mismatch'); expect(f.primary.adapter.context.sourceRevision).toBe(7);
    });
});
