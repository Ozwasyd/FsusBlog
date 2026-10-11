import { describe, expect, it } from 'vitest';

import {
    ArticleDocumentContextAuthority,
    type ArticleDocumentRetainedBinding,
    type ArticleDocumentRetainedPreparation
} from '@/services/authoring/articleDocumentContext';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema } from '@/services/authoring/openArticleDocumentRegistry';

const scope = { readPrincipalIdentityId: () => 'test', readSiteScope: () => 'site:test' };
const input = (articleId: number | null) => ({ articleId, siteScope: 'site:test', userScope: 'user:test', content: '# equal' });

const admit = (registry: OpenArticleDocumentRegistry, context: ArticleDocumentRetainedPreparation['context'], suffix: string) =>
{
    const result = registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'open-or-activate',
        commandId: `open:${suffix}`, idempotencyKey: `open:${suffix}`, expectedRevision: registry.getRevision(),
        intent: 'workspace', entrypoint: 'direct-route',
        identity: { articleId: context.articleId, draftId: context.draftId, documentId: context.documentId },
        documentContext: { documentEpoch: context.documentEpoch,
            sourceRevision: `source-revision:${context.sourceRevision}`, draftRevision: context.draftRevision },
        editorSessionRef: `session:${suffix}`, tabId: `tab:${suffix}`, targetGroupId: 'group:primary', tabKind: 'pinned',
        status: { dirty: false, saving: false, conflict: false, recovery: false, pendingAttachments: false,
            permission: 'allowed', lifecycle: 'current', statusRef: 'status:clean' }, lastActiveAnchorRef: null });
    expect(result.status).toBe('applied');
    return registry.issueRetainedDocumentHandle(`tab:${suffix}`);
};

const create = (authority: ArticleDocumentContextAuthority, registry: OpenArticleDocumentRegistry, articleId: number | null, suffix: string) =>
{
    const prepared = authority.prepareRetainedDocument(registry, input(articleId), scope);
    return authority.acquireRetainedDocument(admit(registry, prepared.context, suffix), prepared);
};

describe('original retained document authority source controls', () =>
{
    it('retains two same-source independent writable adapters and reuses the original handle owner', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, 1, 'first');
        const original = first.adapter.context;
        const pending = first.adapter.beginTask('attachment', 'producer:first');
        const second = create(authority, registry, 2, 'second');
        expect(second.adapter).not.toBe(first.adapter);
        expect(second.adapter.context.contentDigest).toBe(original.contentDigest);
        expect(second.adapter.context.documentId).not.toBe(original.documentId);
        second.adapter.updateSource('# second changed');
        expect(first.adapter.context).toBe(original);
        expect(first.adapter.context.documentEpoch).toBe(original.documentEpoch);
        expect(pending.signal.aborted).toBe(false);
        expect(authority.acquireRetainedDocument(first.handle)).toBe(first);
        expect(first.inspect().registry.entry?.isActive).toBe(false);
        expect(pending.accept('first-result').accepted).toBe(true);
    });

    it('issues two genuine unsaved draft identities without adding a body or journal store', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, null, 'draft-first');
        const second = create(authority, registry, null, 'draft-second');
        expect(first.adapter.context.articleId).toBeNull();
        expect(first.adapter.context.draftId).not.toBe(second.adapter.context.draftId);
        expect(first.adapter.context.documentId).not.toBe(second.adapter.context.documentId);
        expect(first.adapter.context.editorSessionId).not.toBe(second.adapter.context.editorSessionId);
        expect(authority.acquireRetainedDocument(first.handle).adapter.context.draftId).toBe(first.adapter.context.draftId);
    });

    it('adopts the actual primary once and preserves identity/tasks when its component binding releases', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const primary = authority.acquire(input(1));
        const original = primary.adapter.context;
        const task = primary.adapter.beginTask('refresh', 'producer:primary');
        const handle = admit(registry, original, 'primary');
        const retained = authority.adoptPrimaryRetainedDocument(registry, handle, primary, scope);
        expect(retained.adapter).toBe(primary.adapter);
        expect(retained.adapter.context).toBe(original);
        expect(authority.adoptPrimaryRetainedDocument(registry, handle, primary, scope)).toBe(retained);
        primary.release();
        expect(task.signal.aborted).toBe(false);
        expect(() => authority.acquire(input(2))).toThrow('requires-handle');
        expect(() => retained.adapter.switchDocument({ articleId: 2, draftId: 'article:2' })).toThrow('requires-registry');
        expect(task.accept('actual-result').accepted).toBe(true);
    });

    it('rejects a copied primary binding, copied preparation and foreign Registry handle', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const primary = authority.acquire(input(1));
        const handle = admit(registry, primary.adapter.context, 'primary');
        expect(() => authority.adoptPrimaryRetainedDocument(registry, handle, { ...primary }, scope)).toThrow('binding-invalid');
        const prepared = authority.prepareRetainedDocument(registry, input(2), scope);
        const second = admit(registry, prepared.context, 'second');
        expect(() => authority.acquireRetainedDocument(second, { ...prepared })).toThrow('preparation-invalid');
        const foreignRegistry = new OpenArticleDocumentRegistry();
        const foreignHandle = admit(foreignRegistry, prepared.context, 'foreign');
        expect(() => authority.acquireRetainedDocument(foreignHandle, prepared)).toThrow('association-invalid');
    });

    it('keeps canceled work pending until the original producer acknowledges actual settlement', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const task = retained.adapter.beginTask('attachment', 'producer:upload');
        expect(() => task.settle()).toThrow('not-terminal');
        task.cancel('actual-cancellation');
        expect(task.signal.aborted).toBe(true);
        expect(retained.inspect().pendingTaskRefs).toEqual([task.taskRef]);
        task.settle();
        expect(retained.inspect().pendingTaskRefs).toEqual([]);
    });

    it('retains exact-one original consumer and invokes scope invalidation without changing another owner', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, 1, 'first');
        let creations = 0;
        let invalidations = 0;
        const factory = (_binding: ArticleDocumentRetainedBinding) =>
        {
            creations += 1;
            return { originalForm: { value: '# actual owner' }, invalidateDocument: () => { invalidations += 1; } };
        };
        const actual = first.attachConsumer(factory);
        expect(first.attachConsumer(factory)).toBe(actual);
        expect(creations).toBe(1);
        const task = first.adapter.beginTask('refresh', 'producer:save');
        authority.revokeRetainedScope('site:test', 'test');
        expect(invalidations).toBe(1);
        expect(task.signal.aborted).toBe(true);
        expect(first.inspect().pendingTaskRefs).toEqual([task.taskRef]);
        expect(first.inspect().registry.state).toBe('revoked');
        expect(actual.originalForm.value).toBe('# actual owner');
        expect(() => first.adapter.beginTask('render', 'producer:late')).toThrow('owner-unavailable');
        expect(() => first.adapter.updateDraftRevision('revision:late')).toThrow('owner-unavailable');
        task.settle();
    });

    it('rereads real scope sources and keeps callback failure and unfinished work observable', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        let principal: string | null = 'test';
        const readers = { ...scope, readPrincipalIdentityId: () => principal };
        const prepared = authority.prepareRetainedDocument(registry, input(1), readers);
        const retained = authority.acquireRetainedDocument(admit(registry, prepared.context, 'first'), prepared);
        retained.attachConsumer(() => ({ invalidateDocument: () => { throw new Error('real-cleanup-failed'); } }));
        const task = retained.adapter.beginTask('attachment', 'producer:upload');
        principal = null;
        expect(retained.inspect().registry.reason).toBe('scope-revoked');
        expect(retained.inspect().invalidationFailed).toBe(true);
        expect(retained.inspect().pendingTaskRefs).toEqual([task.taskRef]);
        expect(() => retained.adapter.updateSource('# stale')).toThrow('owner-unavailable');
    });

    it('reports canonical revision drift without replacing the document identity or inventing restore readiness', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const original = retained.adapter.context;
        retained.adapter.updateSource('# next');
        expect(retained.inspect().registryRevisionMatchesDocument).toBe(false);
        expect(retained.adapter.context.documentId).toBe(original.documentId);
        expect(retained.adapter.context.documentEpoch).toBe(original.documentEpoch);
        expect(retained.adapter.context.sourceRevision).toBe(original.sourceRevision + 1);
    });

    it('blocks permission without final consumer release or losing unfinished work', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const retained = create(authority, registry, 1, 'first');
        let finalInvalidations = 0;
        retained.attachConsumer(() => ({ invalidateDocument: () => { finalInvalidations += 1; } }));
        const task = retained.adapter.beginTask('attachment', 'producer:pending');
        registry.execute({ schema: openArticleDocumentCommandSchema, kind: 'invalidate-permission',
            commandId: 'permission:revoke', idempotencyKey: 'permission:revoke', expectedRevision: registry.getRevision(),
            tabId: 'tab:first', permission: 'revoked', statusRef: 'status:revoked' });
        expect(retained.inspect().registry.state).toBe('blocked');
        expect(finalInvalidations).toBe(0);
        expect(task.signal.aborted).toBe(true);
        expect(retained.inspect().pendingTaskRefs).toEqual([task.taskRef]);
        expect(() => retained.adapter.updateSource('# denied')).toThrow('owner-unavailable');
    });

    it('revokes every scoped handle before a callback can use another owner or admit a replacement', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, 1, 'first');
        const second = create(authority, registry, 2, 'second');
        let observed = false;
        first.attachConsumer(() => ({ invalidateDocument: () =>
        {
            observed = second.inspect().registry.state === 'revoked';
            expect(() => second.adapter.beginTask('render', 'producer:reentrant')).toThrow('owner-unavailable');
            expect(() => authority.prepareRetainedDocument(registry, input(3), scope)).toThrow('revocation-in-progress');
        } }));
        authority.revokeRetainedScope('site:test', 'test');
        expect(observed).toBe(true);
        expect(first.inspect().invalidationFailed).toBe(false);
        expect(second.inspect().registry.state).toBe('revoked');
    });

    it('refuses Registry epoch and revision coordinates that disagree with the real prepared owner', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const prepared = authority.prepareRetainedDocument(registry, input(1), scope);
        const epochMismatch = admit(registry, { ...prepared.context, documentEpoch: prepared.context.documentEpoch + 1 }, 'wrong-epoch');
        expect(() => authority.acquireRetainedDocument(epochMismatch, prepared)).toThrow('context-mismatch');
        const revisionPrepared = authority.prepareRetainedDocument(registry, input(2), scope);
        const revisionMismatch = admit(registry, { ...revisionPrepared.context, sourceRevision: 99 }, 'wrong-revision');
        expect(() => authority.acquireRetainedDocument(revisionMismatch, revisionPrepared)).toThrow('context-mismatch');
    });

    it('keeps an unsuccessful consumer attachment fenced instead of allocating another resource owner', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        let attempts = 0;
        const createConsumer = () =>
        {
            attempts += 1;
            throw new Error('original-effect-attachment-failed');
        };
        expect(() => retained.attachConsumer(createConsumer)).toThrow('original-effect-attachment-failed');
        expect(retained.inspect().invalidationFailed).toBe(true);
        expect(() => retained.attachConsumer(createConsumer)).toThrow('attachment-unsettled');
        expect(attempts).toBe(1);
    });
});
