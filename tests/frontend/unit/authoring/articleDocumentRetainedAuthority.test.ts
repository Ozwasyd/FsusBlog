import { describe, expect, it } from 'vitest';

import {
    ArticleDocumentContextAuthority,
    type ArticleDocumentRetainedBinding,
    type ArticleDocumentRetainedPreparation
} from '@/services/authoring/articleDocumentContext';
import { OpenArticleDocumentRegistry, openArticleDocumentCommandSchema, revokeRetainedArticleDocumentScope, subscribeRetainedArticleDocumentHandle } from '@/services/authoring/openArticleDocumentRegistry';

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
        expect(task.accept('late-result').accepted).toBe(false);
        task.complete();
        expect(retained.inspect().pendingTaskRefs).toEqual([task.taskRef]);
        task.settle();
        expect(retained.inspect().pendingTaskRefs).toEqual([]);
        const completed = retained.adapter.beginTask('render', 'producer:completed');
        expect(completed.accept('real-result').accepted).toBe(true);
        expect(retained.inspect().pendingTaskRefs).toEqual([completed.taskRef]);
        completed.settle();
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

    it('publishes one terminal envelope before abort callbacks and fences reentrant context mutation', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const original = retained.adapter.context;
        const task = retained.adapter.beginTask('render', 'producer:reentrant');
        let observedStatus: string | null = null;
        task.signal.addEventListener('abort', () =>
        {
            observedStatus = task.accept('late-abort-result').envelope.status;
            expect(() => retained.adapter.updateSource('# reentrant')).toThrow('cancellation-in-progress');
        });
        retained.adapter.cancelAll('actual-suspension');
        expect(observedStatus).toBe('aborted');
        expect(retained.adapter.completedTaskEnvelopes).toHaveLength(1);
        expect(retained.adapter.context).toBe(original);
        expect(retained.inspect().pendingTaskRefs).toEqual([task.taskRef]);
    });

    it('keeps the actually returned asynchronous cleanup pending until its own completion', async () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        let finish: (() => void) | null = null;
        const actualCleanup = new Promise<void>(resolve =>
        {
            finish = resolve;
        });
        retained.attachConsumer(() => ({ invalidateDocument: () => actualCleanup }));
        authority.revokeRetainedScope('site:test', 'test');
        expect(retained.inspect().consumerInvalidationState).toBe('pending');
        const finishActualCleanup = finish as unknown as () => void;
        finishActualCleanup();
        await actualCleanup;
        expect(retained.inspect().consumerInvalidationState).toBe('settled');
        expect(retained.inspect().registry.state).toBe('revoked');
    });

    it('keeps genuine authority records and helper methods runtime private', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const primary = authority.acquire(input(1));
        const handle = admit(registry, primary.adapter.context, 'primary');
        expect(Object.getOwnPropertyNames(authority)).not.toContain('bindingCustody');
        expect(Object.getOwnPropertyNames(primary.adapter)).not.toContain('pendingTasks');
        Object.defineProperty(authority, 'bindingCustody', { value: new WeakMap([[{ ...primary }, { adapter: primary.adapter, isReleased: () => false }]]) });
        expect(() => authority.adoptPrimaryRetainedDocument(registry, handle, { ...primary }, scope)).toThrow('binding-invalid');
        expect((authority as unknown as Record<string, unknown>).createRetainedOwner).toBeUndefined();
    });

    it('reserves actual primary and handle before scope readers can reenter adoption', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const primary = authority.acquire(input(1));
        const handle = admit(registry, primary.adapter.context, 'primary');
        let reentered = false;
        const readers = { ...scope, readPrincipalIdentityId: () =>
        {
            if (!reentered)
            {
                reentered = true;
                expect(() => authority.adoptPrimaryRetainedDocument(registry, handle, primary, scope)).toThrow('admission-in-progress');
            }
            return 'test';
        } };
        const binding = authority.adoptPrimaryRetainedDocument(registry, handle, primary, readers);
        expect(reentered).toBe(true);
        let creations = 0;
        const factory = () => { creations += 1; return { invalidateDocument: () => undefined }; };
        expect(binding.attachConsumer(factory)).toBe(binding.attachConsumer(factory));
        expect(creations).toBe(1);
    });

    it('rechecks primary release and current handle revocation even without a Registry revision change', () =>
    {
        for (const action of ['release', 'revoke'] as const)
        {
            const authority = new ArticleDocumentContextAuthority();
            const registry = new OpenArticleDocumentRegistry();
            const primary = authority.acquire(input(1));
            const handle = admit(registry, primary.adapter.context, 'primary');
            const revision = registry.getRevision();
            let reads = 0;
            const readers = { ...scope, readPrincipalIdentityId: () =>
            {
                reads += 1;
                if (reads === 2)
                {
                    if (action === 'release') primary.release();
                    else revokeRetainedArticleDocumentScope(handle);
                }
                return 'test';
            } };
            expect(() => authority.adoptPrimaryRetainedDocument(registry, handle, primary, readers)).toThrow('admission-changed');
            expect(registry.getRevision()).toBe(revision);
            expect(() => authority.acquireRetainedDocument(handle)).toThrow('preparation-invalid');
        }
    });

    it('releases failed reservations so the same genuine primary can retry after a reader exception', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const primary = authority.acquire(input(1));
        const handle = admit(registry, primary.adapter.context, 'primary');
        expect(() => authority.adoptPrimaryRetainedDocument(registry, handle, primary,
            { ...scope, readPrincipalIdentityId: () => { throw new Error('real-reader-failure'); } })).toThrow('real-reader-failure');
        expect(authority.adoptPrimaryRetainedDocument(registry, handle, primary, scope).adapter).toBe(primary.adapter);
    });

    it('retires unbound preparations across equal-valued scope ABA and creation-time retirement', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const prepared = authority.prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, prepared.context, 'prepared');
        authority.revokeRetainedScope('site:test', 'test');
        expect(() => authority.acquireRetainedDocument(handle, prepared)).toThrow('preparation-invalid');
        const readers = { ...scope, readPrincipalIdentityId: () =>
        {
            authority.revokeRetainedScope('site:test', 'test');
            return 'test';
        } };
        expect(() => authority.prepareRetainedDocument(registry, input(2), readers)).toThrow('scope-retired-during-admission');
    });

    it('drains another actual scope retirement requested by the first consumer', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, 1, 'first');
        const prepared = authority.prepareRetainedDocument(registry, { ...input(2), userScope: 'user:other' },
            { ...scope, readPrincipalIdentityId: () => 'other' });
        const second = authority.acquireRetainedDocument(admit(registry, prepared.context, 'other'), prepared);
        let secondInvalidations = 0;
        second.attachConsumer(() => ({ invalidateDocument: () => { secondInvalidations += 1; } }));
        first.attachConsumer(() => ({ invalidateDocument: () => authority.revokeRetainedScope('site:test', 'other') }));
        authority.revokeRetainedScope('site:test', 'test');
        expect(second.inspect().registry.state).toBe('revoked');
        expect(secondInvalidations).toBe(1);
    });

    it('fences source publication and task-slot creation before external guard reentry', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        let callback: (() => void) | null = null;
        const readers = { ...scope, readPrincipalIdentityId: () => { callback?.(); return 'test'; } };
        const prepared = authority.prepareRetainedDocument(registry, input(1), readers);
        const retained = authority.acquireRetainedDocument(admit(registry, prepared.context, 'first'), prepared);
        callback = () => expect(() => retained.adapter.updateSource('# nested')).toThrow('mutation-in-progress');
        const original = retained.adapter.context;
        retained.adapter.updateSource('# outer');
        expect(retained.adapter.context.sourceRevision).toBe(original.sourceRevision + 1);
        callback = () =>
        {
            callback = null;
            expect(() => retained.adapter.beginTask('render', 'producer:same')).toThrow('start-in-progress');
        };
        const task = retained.adapter.beginTask('render', 'producer:same');
        expect(retained.adapter.cancelAll('real-cancellation')).toContain(task.taskRef);
        expect(task.signal.aborted).toBe(true);
    });

    it('recovers terminal custody after result digest failure without declaring the work settled', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const task = retained.adapter.beginTask('render', 'producer:result');
        const value = { get result() { throw new Error('actual-digest-getter-failure'); } };
        expect(() => task.accept(value)).toThrow('actual-digest-getter-failure');
        expect(task.envelope.status).toBe('running');
        expect(retained.inspect().pendingTaskRefs).toContain(task.taskRef);
        expect(() => task.settle()).toThrow('not-terminal');
        expect(task.cancel('producer-failure-cleanup').status).toBe('aborted');
        expect(retained.adapter.completedTaskEnvelopes).toHaveLength(1);
        expect(retained.inspect().pendingTaskRefs).toContain(task.taskRef);
        task.settle();
        expect(retained.inspect().pendingTaskRefs).toEqual([]);
    });

    it('preserves cancellation during result getters and terminal notification during a live observer', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const retained = create(authority, registry, 1, 'first');
        const task = retained.adapter.beginTask('render', 'producer:result');
        expect(task.accept({ get result() { task.cancel('actual-cancel'); return 'result'; } }).accepted).toBe(false);
        expect(task.envelope.status).toBe('aborted');
        expect(retained.adapter.completedTaskEnvelopes).toHaveLength(1);
        let invalidations = 0;
        retained.attachConsumer(() => ({ invalidateDocument: () => { invalidations += 1; } }));
        const pending = retained.adapter.beginTask('attachment', 'producer:pending');
        subscribeRetainedArticleDocumentHandle(retained.handle, () =>
        {
            if (retained.inspect().registry.state === 'live') revokeRetainedArticleDocumentScope(retained.handle);
        });
        create(authority, registry, 2, 'second');
        expect(pending.signal.aborted).toBe(true);
        expect(invalidations).toBe(1);
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
    });

    it('refuses new-key task issuance from the final source or draft mutation guard', () =>
    {
        for (const mutation of ['source', 'draft'] as const)
        {
            const authority = new ArticleDocumentContextAuthority();
            const registry = new OpenArticleDocumentRegistry();
            let guardReads = 0;
            let armed = false;
            let refused = false;
            const readers = { ...scope, readPrincipalIdentityId: () =>
            {
                if (armed)
                {
                    guardReads += 1;
                    if (guardReads === 2)
                    {
                        expect(() => retained.adapter.beginTask('render', 'producer:new-key')).toThrow('mutation-in-progress');
                        refused = true;
                    }
                }
                return 'test';
            } };
            const prepared = authority.prepareRetainedDocument(registry, input(1), readers);
            const retained = authority.acquireRetainedDocument(admit(registry, prepared.context, 'first'), prepared);
            const old = retained.adapter.beginTask('attachment', 'producer:old');
            armed = true;
            if (mutation === 'source') retained.adapter.updateSource('# next');
            else retained.adapter.updateDraftRevision('draft:next');
            armed = false;
            expect(refused).toBe(true);
            expect(old.signal.aborted).toBe(true);
            expect(retained.adapter.activeTaskRefs).toEqual([]);
            expect(retained.inspect().pendingTaskRefs).toEqual([old.taskRef]);
            old.settle();
            expect(retained.inspect().pendingTaskRefs).toEqual([]);
        }
    });

    it('closes another scope admission synchronously and defers its actual cleanup until drain', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, 1, 'first');
        const otherScope = { ...scope, readPrincipalIdentityId: () => 'other' };
        const prepared = authority.prepareRetainedDocument(registry, { ...input(2), userScope: 'user:other' }, otherScope);
        const second = authority.acquireRetainedDocument(admit(registry, prepared.context, 'second'), prepared);
        const initial = second.adapter.context;
        const pending = second.adapter.beginTask('attachment', 'producer:other');
        let invalidations = 0;
        const secondFactory = () => ({ invalidateDocument: () => { invalidations += 1; } });
        second.attachConsumer(secondFactory);
        let callbackCompleted = false;
        first.attachConsumer(() => ({ invalidateDocument: () =>
        {
            authority.revokeRetainedScope('site:test', 'other');
            expect(second.inspect().admissionClosed).toBe(true);
            expect(second.inspect().registry.state).toBe('live');
            expect(pending.isCurrent()).toBe(false);
            expect(pending.signal.aborted).toBe(false);
            expect(second.inspect().pendingTaskRefs).toContain(pending.taskRef);
            expect(invalidations).toBe(0);
            expect(() => second.adapter.beginTask('render', 'producer:forbidden')).toThrow('owner-unavailable');
            expect(() => second.adapter.updateSource('# forbidden')).toThrow('owner-unavailable');
            expect(() => second.adapter.updateDraftRevision('draft:forbidden')).toThrow('owner-unavailable');
            expect(() => second.attachConsumer(secondFactory)).toThrow('consumer-unavailable');
            expect(second.adapter.context).toBe(initial);
            callbackCompleted = true;
        } }));
        authority.revokeRetainedScope('site:test', 'test');
        expect(callbackCompleted).toBe(true);
        expect(first.inspect().invalidationFailed).toBe(false);
        expect(second.inspect().registry.state).toBe('revoked');
        expect(pending.signal.aborted).toBe(true);
        expect(invalidations).toBe(1);
        expect(second.inspect().pendingTaskRefs).toContain(pending.taskRef);
    });

    it('rechecks synchronous retirement that occurs inside the borrowed scope reader', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, 1, 'first');
        let retireFromRead = false;
        const readers = { ...scope, readPrincipalIdentityId: () =>
        {
            if (retireFromRead)
            {
                retireFromRead = false;
                authority.revokeRetainedScope('site:test', 'other');
            }
            return 'other';
        } };
        const prepared = authority.prepareRetainedDocument(registry, { ...input(2), userScope: 'user:other' }, readers);
        const second = authority.acquireRetainedDocument(admit(registry, prepared.context, 'second'), prepared);
        let refused = false;
        first.attachConsumer(() => ({ invalidateDocument: () =>
        {
            retireFromRead = true;
            expect(() => second.adapter.beginTask('render', 'producer:read-window')).toThrow('owner-unavailable');
            refused = true;
        } }));
        authority.revokeRetainedScope('site:test', 'test');
        expect(refused).toBe(true);
        expect(second.inspect().registry.state).toBe('revoked');
        expect(second.adapter.pendingTaskRefs).toEqual([]);
    });

    it('rejects a consumer retired by factory, getter or post-factory reader while retaining it for drain', () =>
    {
        for (const boundary of ['factory', 'getter', 'reader', 'reader-error'] as const)
        {
            const authority = new ArticleDocumentContextAuthority();
            const registry = new OpenArticleDocumentRegistry();
            const first = create(authority, registry, 1, 'first');
            let readAfterFactory = false;
            const readers = { ...scope, readPrincipalIdentityId: (): string =>
            {
                if (readAfterFactory)
                {
                    readAfterFactory = false;
                    authority.revokeRetainedScope('site:test', 'other');
                    if (boundary === 'reader-error') throw new Error('actual-post-factory-reader-error');
                }
                return 'other';
            } };
            const prepared = authority.prepareRetainedDocument(registry, { ...input(2), userScope: 'user:other' }, readers);
            const second = authority.acquireRetainedDocument(admit(registry, prepared.context, 'second'), prepared);
            const pending = second.adapter.beginTask('attachment', 'producer:pending');
            let returned = false;
            let cleanupCalls = 0;
            let cleanupObservation: ReturnType<ArticleDocumentRetainedBinding['inspect']> | null = null;
            const cleanup = (observation: ReturnType<ArticleDocumentRetainedBinding['inspect']>) =>
            {
                cleanupCalls += 1;
                cleanupObservation = observation;
            };
            const actualConsumer = { get invalidateDocument()
            {
                if (boundary === 'getter') authority.revokeRetainedScope('site:test', 'other');
                return cleanup;
            } };
            const factory = () =>
            {
                if (boundary === 'factory') authority.revokeRetainedScope('site:test', 'other');
                if (boundary === 'reader' || boundary === 'reader-error') readAfterFactory = true;
                return actualConsumer;
            };
            let checked = false;
            first.attachConsumer(() => ({ invalidateDocument: () =>
            {
                expect(() => { second.attachConsumer(factory); returned = true; }).toThrow();
                expect(returned).toBe(false);
                expect(second.inspect().admissionClosed).toBe(true);
                expect(second.inspect().registry.state).toBe('live');
                expect(cleanupCalls).toBe(0);
                expect(second.inspect().pendingTaskRefs).toContain(pending.taskRef);
                checked = true;
            } }));
            authority.revokeRetainedScope('site:test', 'test');
            expect(checked).toBe(true);
            expect(first.inspect().invalidationFailed).toBe(false);
            expect(second.inspect().registry.state).toBe('revoked');
            expect(cleanupCalls).toBe(1);
            expect(cleanupObservation).not.toBeNull();
            expect(second.inspect().pendingTaskRefs).toContain(pending.taskRef);
            expect(pending.signal.aborted).toBe(true);
        }
    });

    it('reserves the consumer slot before entry readers and factory reentry', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        let readerReentry: (() => void) | null = null;
        const readers = { ...scope, readPrincipalIdentityId: () => { readerReentry?.(); return 'test'; } };
        const prepared = authority.prepareRetainedDocument(registry, input(1), readers);
        const retained = authority.acquireRetainedDocument(admit(registry, prepared.context, 'first'), prepared);
        let creations = 0;
        const actualConsumer = { invalidateDocument: () => undefined };
        const factory = () =>
        {
            creations += 1;
            expect(() => retained.attachConsumer(factory)).toThrow('consumer-unavailable');
            return actualConsumer;
        };
        readerReentry = () => expect(() => retained.attachConsumer(factory)).toThrow('consumer-unavailable');
        expect(retained.attachConsumer(factory)).toBe(actualConsumer);
        expect(retained.attachConsumer(factory)).toBe(actualConsumer);
        expect(creations).toBe(1);
    });

    it('retains consumer custody when retirement finishes before factory return and cleanup fails', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const retained = create(authority, registry, 1, 'first');
        const pending = retained.adapter.beginTask('attachment', 'producer:pending');
        let cleanupCalls = 0;
        const actualConsumer = { invalidateDocument: () =>
        {
            cleanupCalls += 1;
            throw new Error('actual-consumer-cleanup-failure');
        } };
        const factory = () =>
        {
            authority.revokeRetainedScope('site:test', 'test');
            return actualConsumer;
        };
        expect(() => retained.attachConsumer(factory)).toThrow('consumer-unavailable');
        expect(retained.inspect().registry.state).toBe('revoked');
        expect(cleanupCalls).toBe(1);
        expect(retained.inspect().consumerInvalidationState).toBe('failed');
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
        expect(() => retained.attachConsumer(factory)).toThrow('consumer-unavailable');
        expect(cleanupCalls).toBe(1);
    });
    it('hands the loaded genuine primary to canonical identity without copying its consumer or settling old work', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const originalIssuer = new ArticleDocumentContextAuthority();
        const canonical = originalIssuer.prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const authority = new ArticleDocumentContextAuthority();
        const primary = authority.acquire(input(1));
        const previous = primary.adapter.context;
        const pending = primary.adapter.beginTask('attachment', 'producer:old-mount');
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        expect(primary.adapter.context).toBe(previous);
        expect(preparation.context.documentId).toBe(canonical.context.documentId);
        const retained = authority.acquireRetainedDocument(handle, preparation);
        expect(retained.adapter).toBe(primary.adapter);
        expect(retained.adapter.context).toBe(preparation.context);
        expect(retained.adapter.context.editorSessionId).toBe(previous.editorSessionId);
        expect(retained.adapter.context.contentDigest).toBe(previous.contentDigest);
        expect(pending.signal.aborted).toBe(true);
        expect(pending.accept('late-old-result').accepted).toBe(false);
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
        expect(retained.adapter.receipts.filter(receipt => receipt.action === 'switch')).toHaveLength(1);
        expect(authority.acquireRetainedDocument(handle, preparation)).toBe(retained);
        const actualConsumer = { invalidateDocument: () => undefined };
        expect(retained.attachConsumer(() => actualConsumer)).toBe(actualConsumer);
        primary.release();
        pending.settle();
        expect(retained.inspect().pendingTaskRefs).toEqual([]);
    });

    it('discards an unused primary offer without disposing the borrowed mounted adapter', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const authority = new ArticleDocumentContextAuthority();
        const primary = authority.acquire(input(1));
        const original = primary.adapter.context;
        const pending = primary.adapter.beginTask('render', 'producer:original');
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        authority.discardRetainedPreparation(preparation);
        expect(primary.adapter.context).toBe(original);
        expect(pending.signal.aborted).toBe(false);
        expect(() => authority.acquireRetainedDocument(handle, preparation)).toThrow('preparation-invalid');
        expect(pending.accept('original-result').accepted).toBe(true);
    });

    it('refuses foreign/copy provenance and already retained primary handover', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const authority = new ArticleDocumentContextAuthority();
        const primary = authority.acquire(input(1));
        expect(() => authority.preparePrimaryRetainedHandover(registry, handle, { ...primary }, scope)).toThrow('binding-invalid');
        expect(() => authority.preparePrimaryRetainedHandover(new OpenArticleDocumentRegistry(), handle, primary, scope))
            .toThrow('association-invalid');
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        expect(() => authority.acquireRetainedDocument(handle, { ...preparation })).toThrow('preparation-invalid');
        authority.acquireRetainedDocument(handle, preparation);
        expect(() => authority.preparePrimaryRetainedHandover(registry, handle, primary, scope)).toThrow();
    });

    it('refuses body coordinate relabeling and different restored unsaved draft identity', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const authority = new ArticleDocumentContextAuthority();
        const primary = authority.acquire(input(1));
        primary.adapter.updateSource('# newer real loaded revision');
        const original = primary.adapter.context;
        expect(() => authority.preparePrimaryRetainedHandover(registry, handle, primary, scope)).toThrow('source-mismatch');
        expect(primary.adapter.context).toBe(original);
        const draftRegistry = new OpenArticleDocumentRegistry();
        const draft = new ArticleDocumentContextAuthority().prepareRetainedDocument(draftRegistry, input(null), scope);
        const draftHandle = admit(draftRegistry, draft.context, 'draft');
        const draftAuthority = new ArticleDocumentContextAuthority();
        const draftPrimary = draftAuthority.acquire(input(null));
        expect(() => draftAuthority.preparePrimaryRetainedHandover(draftRegistry, draftHandle, draftPrimary, scope))
            .toThrow('source-mismatch');
    });

    it('pins source preparation and refuses a real intervening edit before handover', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const authority = new ArticleDocumentContextAuthority();
        const primary = authority.acquire(input(1));
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        primary.adapter.updateSource('# actual intervening edit');
        const edited = primary.adapter.context;
        expect(() => authority.acquireRetainedDocument(handle, preparation)).toThrow('handover-invalid');
        expect(primary.adapter.context).toBe(edited);
        expect(primary.adapter.receipts.filter(receipt => receipt.action === 'switch')).toHaveLength(0);
        authority.discardRetainedPreparation(preparation);
        const task = primary.adapter.beginTask('render', 'producer:after-discard');
        expect(task.accept('real-edited-result').accepted).toBe(true);
        const next = primary.switchDocument({ articleId: 2, content: '# next actual document' });
        expect(next?.articleId).toBe(2);
        const nextPreparation = authority.prepareRetainedDocument(registry, input(3), scope);
        authority.discardRetainedPreparation(nextPreparation);
    });

    it('rechecks actual primary release after synchronous task cancellation and retains unsettled work', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const authority = new ArticleDocumentContextAuthority();
        const primary = authority.acquire(input(1));
        const original = primary.adapter.context;
        const pending = primary.adapter.beginTask('refresh', 'producer:actual');
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        pending.signal.addEventListener('abort', () => primary.release(), { once: true });
        expect(() => authority.acquireRetainedDocument(handle, preparation)).toThrow('admission-changed');
        expect(primary.adapter.context).toBe(original);
        expect(primary.adapter.pendingTaskRefs).toContain(pending.taskRef);
        expect(primary.adapter.receipts.filter(receipt => receipt.action === 'switch')).toHaveLength(0);
    });

    it('retains failed published handover custody instead of rolling back a notified document', () =>
    {
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const authority = new ArticleDocumentContextAuthority();
        const primary = authority.acquire(input(1));
        const pending = primary.adapter.beginTask('refresh', 'producer:actual');
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        primary.adapter.subscribeContext(() => { throw new Error('actual-mount-notification-failed'); });
        expect(() => authority.acquireRetainedDocument(handle, preparation)).toThrow('actual-mount-notification-failed');
        expect(primary.adapter.context).toBe(preparation.context);
        expect(primary.adapter.pendingTaskRefs).toContain(pending.taskRef);
        expect(() => primary.adapter.beginTask('render', 'producer:late')).toThrow();
        expect(() => authority.discardRetainedPreparation(preparation)).toThrow();
        pending.settle();
        expect(primary.adapter.pendingTaskRefs).toEqual([]);
    });

    it('does not move an already registered consumer into another retained owner', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, 1, 'first');
        const second = create(authority, registry, 2, 'second');
        let invalidations = 0;
        const actual = { invalidateDocument: () => { invalidations += 1; } };
        const factory = () => actual;
        first.attachConsumer(factory);
        expect(() => second.attachConsumer(factory)).toThrow('owned-elsewhere');
        expect(first.attachConsumer(factory)).toBe(actual);
        expect(first.inspect().admissionClosed).toBe(false);
        expect(invalidations).toBe(0);
    });
    it('blocks prepared primary admission synchronously during nested scope retirement before cleanup drain', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const outerScope = { readPrincipalIdentityId: () => 'outer', readSiteScope: () => 'site:outer' };
        const outerPreparation = authority.prepareRetainedDocument(registry,
            { articleId: 2, siteScope: 'site:outer', userScope: 'user:outer', content: '# outer' }, outerScope);
        const outer = authority.acquireRetainedDocument(admit(registry, outerPreparation.context, 'outer'), outerPreparation);
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const primary = authority.acquire(input(1));
        const original = primary.adapter.context;
        const pending = primary.adapter.beginTask('attachment', 'producer:pending-primary');
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        let nested = false;
        outer.attachConsumer(() => ({ invalidateDocument: () =>
        {
            authority.revokeRetainedScope('site:test', 'test');
            nested = true;
            expect(pending.signal.aborted).toBe(false);
            expect(primary.adapter.isCurrentContext(original)).toBe(false);
            expect(() => primary.adapter.beginTask('render', 'producer:illegal')).toThrow('owner-unavailable');
            expect(() => primary.adapter.updateSource('# illegal write')).toThrow('owner-unavailable');
            expect(() => authority.acquire(input(1))).toThrow('owner-unavailable');
            expect(() => authority.discardRetainedPreparation(preparation)).toThrow('not-unused');
        } }));
        authority.revokeRetainedScope('site:outer', 'outer');
        expect(nested).toBe(true);
        expect(primary.adapter.context).toBe(original);
        expect(pending.signal.aborted).toBe(true);
        expect(primary.adapter.pendingTaskRefs).toContain(pending.taskRef);
        expect(() => authority.acquireRetainedDocument(handle, preparation)).toThrow('preparation-invalid');
    });

    it('revalidates sole primary binding at consumption and permits a genuine retry after secondary release', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const primary = authority.acquire(input(1));
        const original = primary.adapter.context;
        const pending = primary.adapter.beginTask('refresh', 'producer:original');
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        const secondary = authority.acquire(input(1));
        expect(() => authority.acquireRetainedDocument(handle, preparation)).toThrow('admission-changed');
        expect(primary.adapter.context).toBe(original);
        expect(pending.signal.aborted).toBe(false);
        expect(primary.adapter.receipts.filter(receipt => receipt.action === 'switch')).toHaveLength(0);
        secondary.release();
        const retained = authority.acquireRetainedDocument(handle, preparation);
        expect(retained.adapter).toBe(primary.adapter);
        expect(pending.signal.aborted).toBe(true);
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
    });

    it('releases an edited unused primary pin so the same actual adapter can prepare again', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const primary = authority.acquire(input(1));
        const pending = primary.adapter.beginTask('attachment', 'producer:actual');
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        primary.adapter.updateDraftRevision('draft-revision:actual-edit');
        const edited = primary.adapter.context;
        expect(() => authority.acquireRetainedDocument(handle, preparation)).toThrow('handover-invalid');
        authority.discardRetainedPreparation(preparation);
        expect(primary.adapter.context).toBe(edited);
        expect(primary.adapter.pendingTaskRefs).toContain(pending.taskRef);
        expect(primary.adapter.isCurrentContext(edited)).toBe(true);
        primary.adapter.updateDraftRevision(null);
        const retry = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        expect(authority.acquireRetainedDocument(handle, retry).adapter).toBe(primary.adapter);
    });

    it('cannot adopt around an unused handover pin and cannot discard a published failed handover', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const primary = authority.acquire(input(1));
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        expect(() => authority.adoptPrimaryRetainedDocument(registry, handle, primary, scope)).toThrow('handover-prepared');
        primary.adapter.subscribeContext(() => { throw new Error('actual-publication-failure'); });
        expect(() => authority.acquireRetainedDocument(handle, preparation)).toThrow('actual-publication-failure');
        expect(() => authority.discardRetainedPreparation(preparation)).toThrow();
        expect(() => primary.adapter.updateSource('# after publication failure')).toThrow('owner-unavailable');
    });
    it('drains queued original scopes after a real borrowed-primary disposal listener failure', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const make = (articleId: number, principal: string) =>
        {
            const originalScope = { readPrincipalIdentityId: () => principal, readSiteScope: () => `site:${principal}` };
            const prepared = authority.prepareRetainedDocument(registry,
                { articleId, siteScope: `site:${principal}`, userScope: `user:${principal}`, content: '# original' }, originalScope);
            return authority.acquireRetainedDocument(admit(registry, prepared.context, principal), prepared);
        };
        const outer = make(2, 'outer');
        const tail = make(3, 'tail');
        const tailTask = tail.adapter.beginTask('attachment', 'producer:tail');
        let tailCleanup = false;
        tail.attachConsumer(() => ({ invalidateDocument: () => { tailCleanup = true; } }));
        const canonical = new ArticleDocumentContextAuthority().prepareRetainedDocument(registry, input(1), scope);
        const handle = admit(registry, canonical.context, 'restored');
        const primary = authority.acquire(input(1));
        const preparation = authority.preparePrimaryRetainedHandover(registry, handle, primary, scope);
        const primaryTask = primary.adapter.beginTask('refresh', 'producer:primary');
        primary.adapter.subscribeContext(() => { throw new Error('actual-borrowed-cleanup-failure'); });
        outer.attachConsumer(() => ({ invalidateDocument: () =>
        {
            authority.revokeRetainedScope('site:test', 'test');
            authority.revokeRetainedScope('site:tail', 'tail');
        } }));
        expect(() => authority.revokeRetainedScope('site:outer', 'outer')).toThrow('scope-cleanup-failed');
        expect(tailCleanup).toBe(true);
        expect(tail.inspect().registry.state).toBe('revoked');
        expect(tailTask.signal.aborted).toBe(true);
        expect(tail.inspect().pendingTaskRefs).toContain(tailTask.taskRef);
        expect(primaryTask.signal.aborted).toBe(true);
        expect(primary.adapter.pendingTaskRefs).toContain(primaryTask.taskRef);
        expect(() => authority.discardRetainedPreparation(preparation)).toThrow('not-unused');
        expect(() => primary.adapter.beginTask('render', 'producer:late')).toThrow('owner-unavailable');
    });
    it('joins lifetime seals to the original binding, membership, adapter and consumer custody', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const first = create(authority, registry, 1, 'first');
        const second = create(authority, registry, 2, 'second');
        const seal = first.sealLifetimeAuthority()!;
        expect(first.hasLifetimeAuthorityCustody(seal)).toBe(true);
        expect(second.hasLifetimeAuthorityCustody(seal)).toBe(false);
        expect(second.cancelLifetimeAuthority(seal)).toBe(false);
        expect(first.hasLifetimeAuthorityCustody({ ...seal })).toBe(false);
        expect(first.cancelLifetimeAuthority(seal)).toBe(true);
        expect(first.hasLifetimeAuthorityCustody(seal)).toBe(false);
        expect(first.cancelLifetimeAuthority(seal)).toBe(false);
    });

    it('retires original native context custody before source guards and real task abort callbacks', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const pending = retained.adapter.beginTask('attachment', 'producer:actual');
        const seal = retained.sealLifetimeAuthority()!;
        let observed = false;
        pending.signal.addEventListener('abort', () =>
        {
            observed = true;
            expect(retained.hasLifetimeAuthorityCustody(seal)).toBe(false);
        });
        retained.adapter.updateSource('# actual next source');
        expect(observed).toBe(true);
        expect(retained.hasLifetimeAuthorityCustody(seal)).toBe(false);
        expect(retained.sealLifetimeAuthority()).toBeNull();
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
    });

    it('retires original owner seals before attachment factory and final consumer cleanup callbacks', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const beforeAttach = retained.sealLifetimeAuthority()!;
        let currentSeal = beforeAttach;
        let cleanupObserved = false;
        retained.attachConsumer(() =>
        {
            expect(retained.hasLifetimeAuthorityCustody(beforeAttach)).toBe(false);
            return { invalidateDocument: () =>
            {
                cleanupObserved = true;
                expect(retained.hasLifetimeAuthorityCustody(currentSeal)).toBe(false);
            } };
        });
        currentSeal = retained.sealLifetimeAuthority()!;
        expect(retained.hasLifetimeAuthorityCustody(currentSeal)).toBe(true);
        authority.revokeRetainedScope('site:test', 'test');
        expect(cleanupObserved).toBe(true);
        expect(retained.hasLifetimeAuthorityCustody(currentSeal)).toBe(false);
    });

    it('checks sealed lifetime custody without calling public context getters or raw scope readers', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        let reads = 0;
        const originalScope = { readPrincipalIdentityId: () => { reads += 1; return 'test'; },
            readSiteScope: () => { reads += 1; return 'site:test'; } };
        const prepared = authority.prepareRetainedDocument(registry, input(1), originalScope);
        const retained = authority.acquireRetainedDocument(admit(registry, prepared.context, 'first'), prepared);
        const seal = retained.sealLifetimeAuthority()!;
        const before = reads;
        Object.defineProperty(retained.adapter, 'context', { get: () => { throw new Error('external-context-reader'); } });
        expect(retained.hasLifetimeAuthorityCustody(seal)).toBe(true);
        expect(reads).toBe(before);
        expect(retained.cancelLifetimeAuthority(seal)).toBe(true);
        expect(reads).toBe(before);
    });
    it('delivers queued real Document cancellation and failed consumer custody after a throwing Registry getter', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        const retained = create(authority, registry, 1, 'first');
        const pending = retained.adapter.beginTask('attachment', 'producer:actual');
        let cleanups = 0;
        retained.attachConsumer(() => ({ invalidateDocument: () =>
        {
            cleanups += 1;
            throw new Error('actual-consumer-cleanup-failure');
        } }));
        const originalFailure = new Error('actual-getter-failure');
        const command = { schema: openArticleDocumentCommandSchema };
        Object.defineProperty(command, 'schema', { enumerable: true, get: () =>
        {
            revokeRetainedArticleDocumentScope(retained.handle);
            expect(pending.signal.aborted).toBe(false);
            throw originalFailure;
        } });
        let caught: unknown;
        try
        {
            registry.execute(command);
        }
        catch (error)
        {
            caught = error;
        }
        expect(caught).toBe(originalFailure);
        expect(pending.signal.aborted).toBe(true);
        expect(cleanups).toBe(1);
        expect(retained.inspect().consumerInvalidationState).toBe('failed');
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
    });

    it('pins non-null lifetime publication before token allocation and refuses cached-attachment reentry', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const consumer = { invalidateDocument: () => undefined };
        const factory = () => consumer;
        retained.attachConsumer(factory);
        const originalSeal = retained.sealLifetimeAuthority()!;
        const originalFreeze = Object.freeze;
        let emptyAllocations = 0;
        let candidate: object | null = null;
        try
        {
            Object.freeze = ((value: unknown) =>
            {
                if (value && typeof value === 'object' && Object.keys(value).length === 0)
                {
                    emptyAllocations += 1;
                    if (emptyAllocations === 2)
                    {
                        candidate = value;
                        expect(retained.attachConsumer(factory)).toBe(consumer);
                        expect(retained.hasLifetimeAuthorityCustody(originalSeal)).toBe(false);
                    }
                }
                return originalFreeze(value);
            }) as typeof Object.freeze;
            expect(retained.sealLifetimeAuthority()).toBeNull();
        }
        finally
        {
            Object.freeze = originalFreeze;
        }
        expect(emptyAllocations).toBe(2);
        expect(candidate).not.toBeNull();
        expect(retained.hasLifetimeAuthorityCustody(candidate as NonNullable<ReturnType<typeof retained.sealLifetimeAuthority>>)).toBe(false);
        expect(retained.hasLifetimeAuthorityCustody(originalSeal)).toBe(false);
        retained.attachConsumer(factory);
        expect(retained.hasLifetimeAuthorityCustody(originalSeal)).toBe(false);
        expect(retained.hasLifetimeAuthorityCustody(candidate as NonNullable<ReturnType<typeof retained.sealLifetimeAuthority>>)).toBe(false);
        const currentSeal = retained.sealLifetimeAuthority()!;
        expect(retained.hasLifetimeAuthorityCustody(currentSeal)).toBe(true);
        expect(retained.hasLifetimeAuthorityCustody(originalSeal)).toBe(false);
    });
    it('signals genuine Document retirement before context mutation, guards and task abort', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const previous = retained.adapter.context;
        const pending = retained.adapter.beginTask('attachment', 'producer:actual');
        const seal = retained.sealLifetimeAuthority()!;
        const events: string[] = [];
        const stop = retained.subscribeRetirement(() =>
        {
            events.push('pre');
            expect(retained.adapter.context).toBe(previous);
            expect(pending.signal.aborted).toBe(false);
            expect(retained.hasLifetimeAuthorityCustody(seal)).toBe(false);
            expect(retained.sealLifetimeAuthority()).toBeNull();
            expect(() => authority.acquire(input(2))).toThrow('retirement-in-progress');
        });
        pending.signal.addEventListener('abort', () =>
        {
            events.push('abort');
            expect(events[0]).toBe('pre');
        });
        retained.adapter.updateSource('# actual next body');
        stop();
        expect(events[0]).toBe('pre');
        expect(events).toContain('abort');
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
    });

    it('preserves actual Document context and pending custody when a pre-retirement listener fails', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const previous = retained.adapter.context;
        const pending = retained.adapter.beginTask('attachment', 'producer:actual');
        const failure = new Error('actual-root-retirement-failure');
        let secondCalled = false;
        retained.subscribeRetirement(() => { throw failure; });
        retained.subscribeRetirement(() => { secondCalled = true; });
        expect(() => retained.adapter.updateSource('# refused body mutation')).toThrow('pre-retirement-failed');
        expect(secondCalled).toBe(true);
        expect(retained.adapter.context).toBe(previous);
        expect(pending.signal.aborted).toBe(false);
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
        expect(retained.inspect().invalidationFailed).toBe(true);
        expect(retained.sealLifetimeAuthority()).toBeNull();
    });
    it('retains failed owner unsubscribe and retries the same original listener without restoring authority', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const firstFailure = new Error('original-owner-listener-failure');
        let shouldFail = true;
        let calls = 0;
        const stop = retained.subscribeRetirement(() =>
        {
            calls += 1;
            if (shouldFail) { throw firstFailure; }
        });
        expect(() => retained.adapter.updateSource('# refused')).toThrow();
        stop();
        expect(stop.inspect().pendingUnsubscribe).toBe(true);
        expect(stop.inspect().firstFailure).toBe(firstFailure);
        shouldFail = false;
        stop.retry();
        expect(stop.inspect().failed).toBe(false);
        expect(stop.inspect().firstFailure).toBe(firstFailure);
        const completedCalls = calls;
        stop.retry();
        expect(calls).toBe(completedCalls);
        expect(retained.inspect().invalidationFailed).toBe(true);
        expect(retained.sealLifetimeAuthority()).toBeNull();
    });

    it('retains adapter context failure and retries a pending unsubscribe against actual current context', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const firstFailure = new Error('original-context-listener-failure');
        let shouldFail = true;
        let observed: unknown = null;
        const stop = retained.adapter.subscribeContext(context =>
        {
            observed = context;
            if (shouldFail) { throw firstFailure; }
        });
        expect(() => retained.adapter.updateSource('# published')).toThrow();
        stop();
        expect(stop.inspect().failed).toBe(true);
        expect(stop.inspect().firstFailure).toBe(firstFailure);
        shouldFail = false;
        stop.retry();
        expect(observed).toBe(retained.adapter.context);
        expect(stop.inspect().failed).toBe(false);
    });

    it('attempts real mandatory consumer cleanup despite pre-listener failure and retries actual cleanup failure', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        const work = retained.adapter.beginTask('attachment', 'producer:actual');
        let cleanupFails = true;
        let cleanups = 0;
        retained.attachConsumer(() => ({ invalidateDocument: () =>
        {
            cleanups += 1;
            if (cleanupFails) { throw new Error('actual-consumer-cleanup-failure'); }
        } }));
        const stop = retained.subscribeRetirement(() => { throw new Error('actual-pre-signal-failure'); });
        expect(() => authority.revokeRetainedScope('site:test', 'test')).toThrow();
        expect(cleanups).toBeGreaterThan(0);
        expect(work.signal.aborted).toBe(true);
        expect(retained.inspect().consumerInvalidationState).toBe('failed');
        expect(retained.inspect().pendingTaskRefs).toContain(work.taskRef);
        stop();
        cleanupFails = false;
        // A failing pre-signal remains an obligation; actual consumer cleanup is
        // still attempted and does not force unresolved work to settle.
        try { retained.retryInvalidation(); } catch { /* actual pre-failure remains reported */ }
        expect(retained.inspect().consumerInvalidationState).toBe('settled');
        expect(retained.inspect().pendingTaskRefs).toContain(work.taskRef);
    });

    it('does not duplicate an actual pending consumer promise when retry is requested', async () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        let complete!: () => void;
        const pending = new Promise<void>(resolve => { complete = resolve; });
        let calls = 0;
        retained.attachConsumer(() => ({ invalidateDocument: () => { calls += 1; return pending; } }));
        authority.revokeRetainedScope('site:test', 'test');
        expect(retained.inspect().consumerInvalidationState).toBe('pending');
        retained.retryInvalidation();
        expect(calls).toBe(1);
        expect(retained.inspect().consumerInvalidationState).toBe('pending');
        complete();
        await pending;
        expect(retained.inspect().consumerInvalidationState).toBe('settled');
    });

    it('rejects owner post-listener invalidation retry before cancel or disposal and preserves pending cleanup', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        let reads = 0;
        const readers = { readPrincipalIdentityId: () => { reads += 1; return 'test'; }, readSiteScope: () => 'site:test' };
        const prepared = authority.prepareRetainedDocument(registry, input(1), readers);
        const retained = authority.acquireRetainedDocument(admit(registry, prepared.context, 'first'), prepared);
        let calls = 0;
        const pending = new Promise<void>(() => undefined);
        retained.attachConsumer(() => ({ invalidateDocument: () => { calls += 1; return pending; } }));
        const cancel = retained.adapter.cancelAll.bind(retained.adapter);
        const dispose = retained.adapter.dispose.bind(retained.adapter);
        let cancels = 0;
        let disposals = 0;
        retained.adapter.cancelAll = reason => { cancels += 1; return cancel(reason); };
        retained.adapter.dispose = () => { disposals += 1; return dispose(); };
        const rejected: unknown[] = [];
        retained.subscribeLifetime(() =>
        {
            const before = [cancels, disposals, calls, reads];
            try { retained.retryInvalidation(); } catch (error) { rejected.push(error); }
            expect([cancels, disposals, calls, reads]).toEqual(before);
        });
        authority.revokeRetainedScope('site:test', 'test');
        expect(rejected.length).toBeGreaterThan(0);
        expect((rejected[0] as Error).message).toBe('article-document-invalidation-retry-in-progress');
        expect(calls).toBe(1);
        expect(retained.inspect().consumerInvalidationState).toBe('pending');
        expect(retained.inspect().invalidationFailed).toBe(true);
        expect(retained.sealLifetimeAuthority()).toBeNull();
    });

    it('retains caught context retry reentry as an actual failure until a later callback succeeds', () =>
    {
        const retained = create(new ArticleDocumentContextAuthority(), new OpenArticleDocumentRegistry(), 1, 'first');
        let reenter = true;
        let first: unknown;
        let calls = 0;
        const stop = retained.adapter.subscribeContext(() =>
        {
            calls += 1;
            if (reenter)
            {
                try { stop.retry(); } catch (error) { first = error; }
            }
        });
        expect(() => retained.adapter.updateSource('# published')).toThrow('context-notification-failed');
        expect(calls).toBe(1);
        expect(stop.inspect().failed).toBe(true);
        expect(stop.inspect().firstFailure).toBe(first);
        stop();
        expect(stop.inspect().pendingUnsubscribe).toBe(true);
        reenter = false;
        stop.retry();
        expect(calls).toBe(2);
        expect(stop.inspect().failed).toBe(false);
        expect(stop.inspect().firstFailure).toBe(first);
    });

    it('rejects cancel and dispose before native post-listener mutation and preserves the published context', () =>
    {
        const retained = create(new ArticleDocumentContextAuthority(), new OpenArticleDocumentRegistry(), 1, 'first');
        const pending = retained.adapter.beginTask('attachment', 'producer:actual');
        const rejected: unknown[] = [];
        retained.adapter.subscribeContext(context =>
        {
            const before = retained.adapter.context;
            try { retained.adapter.cancelAll(); } catch (error) { rejected.push(error); }
            try { retained.adapter.dispose(); } catch (error) { rejected.push(error); }
            expect(retained.adapter.context).toBe(before);
            expect(context).toBe(before);
        });
        retained.adapter.updateSource('# published');
        expect(rejected).toHaveLength(2);
        expect((rejected[0] as Error).message).toBe('article-document-retirement-in-progress');
        expect((rejected[1] as Error).message).toBe('article-document-dispose-notification-in-progress');
        expect(pending.signal.aborted).toBe(true);
        expect(retained.inspect().pendingTaskRefs).toContain(pending.taskRef);
    });

    it('rejects every original owner and native subscription retry before readers during consumer create', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const registry = new OpenArticleDocumentRegistry();
        let reads = 0;
        const readers = { readPrincipalIdentityId: () => { reads += 1; return 'test'; }, readSiteScope: () => 'site:test' };
        const prepared = authority.prepareRetainedDocument(registry, input(1), readers);
        const retained = authority.acquireRetainedDocument(admit(registry, prepared.context, 'first'), prepared);
        let preCalls = 0;
        let postCalls = 0;
        let nativeCalls = 0;
        const pre = retained.subscribeRetirement(() => { preCalls += 1; });
        const post = retained.subscribeLifetime(() => { postCalls += 1; });
        const native = retained.adapter.subscribeContext(() => { nativeCalls += 1; });
        const failures: unknown[] = [];
        const consumer = { invalidateDocument: () => undefined };
        expect(retained.attachConsumer(() =>
        {
            const before = [reads, preCalls, postCalls, nativeCalls];
            for (const stop of [pre, post, native])
            {
                try { stop.retry(); } catch (error) { failures.push(error); }
                expect([reads, preCalls, postCalls, nativeCalls]).toEqual(before);
            }
            return consumer;
        })).toBe(consumer);
        expect(failures).toHaveLength(3);
        for (const [index, stop] of [pre, post, native].entries())
        {
            expect(stop.inspect().failed).toBe(true);
            expect(stop.inspect().firstFailure).toBe(failures[index]);
            stop();
            expect(stop.inspect().pendingUnsubscribe).toBe(true);
        }
        pre.retry();
        post.retry();
        native.retry();
        expect(pre.inspect().failed).toBe(false);
        expect(post.inspect().failed).toBe(false);
        expect(native.inspect().failed).toBe(false);
    });

    it('rejects native subscription retry during real consumer cleanup without duplicating pending work', () =>
    {
        const authority = new ArticleDocumentContextAuthority();
        const retained = create(authority, new OpenArticleDocumentRegistry(), 1, 'first');
        let nativeCalls = 0;
        const native = retained.adapter.subscribeContext(() => { nativeCalls += 1; });
        const pending = new Promise<void>(() => undefined);
        let rejected: unknown;
        let cleanups = 0;
        retained.attachConsumer(() => ({ invalidateDocument: () =>
        {
            cleanups += 1;
            const before = nativeCalls;
            try { native.retry(); } catch (error) { rejected = error; }
            expect(nativeCalls).toBe(before);
            return pending;
        } }));
        authority.revokeRetainedScope('site:test', 'test');
        expect(rejected).toBeInstanceOf(Error);
        expect(native.inspect().failed).toBe(true);
        expect(native.inspect().firstFailure).toBe(rejected);
        expect(retained.inspect().consumerInvalidationState).toBe('pending');
        retained.retryInvalidation();
        expect(cleanups).toBe(1);
    });
});
