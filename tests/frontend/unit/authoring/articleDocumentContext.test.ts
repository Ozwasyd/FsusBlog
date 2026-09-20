import { describe, expect, it } from 'vitest';

import {
    ArticleDocumentContextAuthority,
    articleDocumentTaskKinds,
    createArticleDocumentContext,
    createArticleDocumentContextAdapter,
    validateArticleDocumentContext,
    validateArticleDocumentEpochReceipt,
    validateArticleDocumentTaskEnvelope
} from '@/services/authoring';

const createAdapter = () => createArticleDocumentContextAdapter({
    articleId: 1,
    draftId: 'article:1',
    editorSessionId: 'session:test',
    siteScope: 'site:test',
    userScope: 'user:test',
    content: '# shared source'
});

describe('ArticleDocumentContextAdapter (#2243)', () => {
    it('isolates A/B same-source and different-source article identities', () => {
        const authority = new ArticleDocumentContextAuthority();
        const binding = authority.acquire({
            articleId: 1,
            siteScope: 'site:test',
            userScope: 'user:test',
            content: '# shared'
        });
        const articleA = binding.adapter.context;
        binding.switchDocument({
            articleId: 2,
            content: '# shared',
            reason: 'article-switch'
        });
        const sameSourceArticleB = binding.adapter.context;
        binding.switchDocument({
            articleId: 3,
            content: '# different',
            reason: 'article-switch'
        });
        const differentSourceArticleB = binding.adapter.context;

        expect(sameSourceArticleB.contentDigest).toBe(articleA.contentDigest);
        expect(sameSourceArticleB.documentId).not.toBe(articleA.documentId);
        expect(sameSourceArticleB.documentEpoch).toBe(articleA.documentEpoch + 1);
        expect(differentSourceArticleB.contentDigest).not.toBe(sameSourceArticleB.contentDigest);
        expect(differentSourceArticleB.documentId).not.toBe(sameSourceArticleB.documentId);
        expect(differentSourceArticleB.documentEpoch).toBe(sameSourceArticleB.documentEpoch + 1);
        binding.release();
    });

    it('seals a closed context and keeps source content out of the identity', () => {
        const first = createArticleDocumentContext({
            articleId: 1,
            draftId: 'article:1',
            documentId: 'document:a',
            documentEpoch: 1,
            sourceRevision: 0,
            draftRevision: null,
            editorSessionId: 'session:a',
            siteScope: 'site:test',
            userScope: 'user:test',
            content: '# shared source'
        });
        const second = createArticleDocumentContext({
            ...first,
            documentId: 'document:b',
            content: '# shared source'
        });

        expect(validateArticleDocumentContext(first)).toBe(true);
        expect(validateArticleDocumentContext(second)).toBe(true);
        expect(first.contentDigest).toBe(second.contentDigest);
        expect(first.sourceIdentityDigest).not.toBe(second.sourceIdentityDigest);
        expect(first.contextDigest).not.toBe(second.contextDigest);
        expect(validateArticleDocumentContext({ ...first, contextDigest: '0'.repeat(64) })).toBe(false);
        expect(Object.keys(first).sort()).toEqual([
            'articleId',
            'contentDigest',
            'contextDigest',
            'documentEpoch',
            'documentId',
            'draftId',
            'draftRevision',
            'editorSessionId',
            'schema',
            'siteScope',
            'sourceIdentityDigest',
            'sourceRevision',
            'userScope'
        ]);
    });

    it('updates source and draft revisions without creating a document epoch', () => {
        const adapter = createAdapter();
        const initial = adapter.context;
        const same = adapter.updateSource('# shared source');
        expect(same).toBe(initial);

        const sourceChanged = adapter.updateSource('# changed source');
        expect(sourceChanged.documentId).toBe(initial.documentId);
        expect(sourceChanged.documentEpoch).toBe(initial.documentEpoch);
        expect(sourceChanged.sourceRevision).toBe(initial.sourceRevision + 1);
        expect(sourceChanged.contentDigest).not.toBe(initial.contentDigest);

        const digest = sourceChanged.contentDigest;
        const draftChanged = adapter.updateDraftRevision('server:1');
        expect(draftChanged.documentId).toBe(initial.documentId);
        expect(draftChanged.documentEpoch).toBe(initial.documentEpoch);
        expect(draftChanged.sourceRevision).toBe(sourceChanged.sourceRevision);
        expect(draftChanged.contentDigest).toBe(digest);
    });

    it('creates a fresh epoch for a new draft identity after an ordinary revision update', () => {
        const adapter = createAdapter();
        const initial = adapter.context;
        adapter.updateDraftRevision('server:1');
        expect(adapter.context.documentEpoch).toBe(initial.documentEpoch);
        expect(adapter.context.documentId).toBe(initial.documentId);

        const receipt = adapter.switchDocument({
            articleId: null,
            draftId: 'draft:next',
            content: '# shared source',
            reason: 'draft-switch'
        });
        expect(receipt?.reason).toBe('draft-switch');
        expect(adapter.context.documentEpoch).toBe(initial.documentEpoch + 1);
        expect(adapter.context.documentId).not.toBe(initial.documentId);
        expect(adapter.context.contentDigest).toBe(initial.contentDigest);
        expect(validateArticleDocumentEpochReceipt(receipt)).toBe(true);
    });

    it('binds every Blog-owned async task kind and accepts only the current result', () => {
        const adapter = createAdapter();
        for (const kind of articleDocumentTaskKinds)
        {
            const task = adapter.beginTask(kind, `producer:${kind}`);
            const accepted = task.accept({ kind });
            expect(accepted.accepted).toBe(true);
            expect(accepted.reason).toBeNull();
            expect(accepted.envelope.status).toBe('completed');
            expect(validateArticleDocumentTaskEnvelope(accepted.envelope)).toBe(true);
        }
        expect(adapter.activeTaskRefs).toEqual([]);
        expect(adapter.completedTaskEnvelopes).toHaveLength(articleDocumentTaskKinds.length);
    });

    it('aborts all old tasks and rejects late same-source results after an explicit switch', () => {
        const adapter = createAdapter();
        const oldRender = adapter.beginTask('render', 'producer:render');
        const oldSearch = adapter.beginTask('search', 'producer:search');
        const old = adapter.context;
        const receipt = adapter.switchDocument({
            articleId: 2,
            draftId: 'article:2',
            content: '# shared source',
            reason: 'article-switch'
        });

        expect(oldRender.signal.aborted).toBe(true);
        expect(oldSearch.signal.aborted).toBe(true);
        expect(adapter.context.documentEpoch).toBe(old.documentEpoch + 1);
        expect(adapter.context.documentId).not.toBe(old.documentId);
        expect(adapter.context.contentDigest).toBe(old.contentDigest);
        expect(receipt).not.toBeNull();
        expect(receipt?.action).toBe('switch');
        expect(receipt?.canceledTaskRefs).toEqual([oldRender.taskRef, oldSearch.taskRef].sort());
        expect(validateArticleDocumentEpochReceipt(receipt)).toBe(true);

        const late = oldRender.accept({ result: 'old' });
        expect(late.accepted).toBe(false);
        expect(late.envelope.status).toBe('aborted');

        const current = adapter.beginTask('render', 'producer:render');
        expect(current.accept({ result: 'new' }).accepted).toBe(true);
    });

    it('does not advance the epoch for a no-op entity switch or for a stale completion revision', () => {
        const adapter = createAdapter();
        const initial = adapter.context;
        expect(adapter.switchDocument({
            articleId: 1,
            draftId: 'article:1',
            content: '# shared source',
            reason: 'article-switch'
        })).toBeNull();
        expect(adapter.context.documentEpoch).toBe(initial.documentEpoch);
        expect(adapter.receipts).toHaveLength(1);

        const task = adapter.beginTask('projection', 'producer:projection');
        const rejected = task.accept({ projection: 'late' }, initial.sourceRevision + 1);
        expect(rejected.accepted).toBe(false);
        expect(rejected.reason).toBe('completed-revision-stale');
        expect(rejected.envelope.status).toBe('stale');
        expect(validateArticleDocumentTaskEnvelope(rejected.envelope)).toBe(true);
    });

    it('cancels each rapid intermediate epoch and records only exact lifecycle receipts', () => {
        const adapter = createAdapter();
        const first = adapter.beginTask('attachment', 'producer:upload');
        const firstReceipt = adapter.switchDocument({
            articleId: 2,
            draftId: 'article:2',
            content: '# A',
            reason: 'article-switch'
        });
        const second = adapter.beginTask('search', 'producer:search');
        const secondReceipt = adapter.switchDocument({
            articleId: 3,
            draftId: 'article:3',
            content: '# B',
            reason: 'entity-switch'
        });

        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
        expect(firstReceipt?.canceledTaskRefs).toEqual([first.taskRef]);
        expect(secondReceipt?.canceledTaskRefs).toEqual([second.taskRef]);
        expect(adapter.receipts.filter(receipt => receipt.action === 'switch')).toHaveLength(2);
        expect(first.accept({ late: true }).accepted).toBe(false);
        expect(second.accept({ late: true }).accepted).toBe(false);
        expect(adapter.context.articleId).toBe(3);
        expect(adapter.context.documentEpoch).toBe(3);
    });

    it('retains one opaque identity and epoch across component release and remount', () => {
        const authority = new ArticleDocumentContextAuthority();
        const firstBinding = authority.acquire({
            articleId: 41,
            siteScope: 'site:test',
            userScope: 'user:test',
            content: '# retained'
        });
        const firstContext = firstBinding.adapter.context;
        const pending = firstBinding.adapter.beginTask('render', 'producer:render');

        firstBinding.release();
        expect(pending.signal.aborted).toBe(true);

        const remounted = authority.acquire({
            articleId: 41,
            siteScope: 'site:test',
            userScope: 'user:test'
        });
        expect(remounted.adapter).toBe(firstBinding.adapter);
        expect(remounted.adapter.context.documentId).toBe(firstContext.documentId);
        expect(remounted.adapter.context.documentEpoch).toBe(firstContext.documentEpoch);
        expect(remounted.adapter.receipts.filter(receipt => receipt.action === 'switch')).toHaveLength(0);
        remounted.release();
    });

    it('creates exact-one switch receipt for entity changes and reuses the new draft on remount', () => {
        const authority = new ArticleDocumentContextAuthority();
        const binding = authority.acquire({
            articleId: 9,
            siteScope: 'site:test',
            userScope: 'user:test',
            content: '# article'
        });
        const before = binding.adapter.context;
        const receipt = binding.switchDocument({
            articleId: null,
            content: '# same bytes',
            reason: 'draft-switch'
        });

        expect(receipt?.action).toBe('switch');
        expect(binding.adapter.context.articleId).toBeNull();
        expect(binding.adapter.context.documentEpoch).toBe(before.documentEpoch + 1);
        expect(binding.adapter.context.documentId).not.toBe(before.documentId);
        expect(binding.adapter.receipts.filter(item => item.action === 'switch')).toHaveLength(1);
        const draftContext = binding.adapter.context;
        binding.release();

        const remounted = authority.acquire({
            articleId: null,
            siteScope: 'site:test',
            userScope: 'user:test'
        });
        expect(remounted.adapter.context.documentId).toBe(draftContext.documentId);
        expect(remounted.adapter.context.documentEpoch).toBe(draftContext.documentEpoch);
        expect(remounted.adapter.receipts.filter(item => item.action === 'switch')).toHaveLength(1);
        remounted.release();
    });

    it('advances exact-one epoch when a user explicitly replaces one unsaved draft with another', () => {
        const authority = new ArticleDocumentContextAuthority();
        const binding = authority.acquire({
            articleId: null,
            siteScope: 'site:test',
            userScope: 'user:test',
            content: '# first draft'
        });
        const firstDraft = binding.adapter.context;

        const receipt = binding.switchDocument({
            articleId: null,
            content: '# same bytes are still a different draft',
            reason: 'draft-switch'
        });

        expect(receipt?.action).toBe('switch');
        expect(binding.adapter.context.documentEpoch).toBe(firstDraft.documentEpoch + 1);
        expect(binding.adapter.context.documentId).not.toBe(firstDraft.documentId);
        expect(binding.adapter.context.draftId).not.toBe(firstDraft.draftId);
        expect(binding.adapter.receipts.filter(item => item.action === 'switch')).toHaveLength(1);
        binding.release();
    });

    it('treats site or user scope changes as an entity switch without route or content authority', () => {
        const authority = new ArticleDocumentContextAuthority();
        const first = authority.acquire({
            articleId: 5,
            siteScope: 'site:one',
            userScope: 'user:one',
            content: '# equal'
        });
        const before = first.adapter.context;
        first.release();

        const second = authority.acquire({
            articleId: 5,
            siteScope: 'site:one',
            userScope: 'user:two',
            content: '# equal'
        });
        expect(second.adapter.context.documentEpoch).toBe(before.documentEpoch + 1);
        expect(second.adapter.context.contentDigest).toBe(before.contentDigest);
        expect(second.adapter.context.userScope).toBe('user:two');
        expect(second.adapter.receipts.filter(receipt => receipt.action === 'switch')).toHaveLength(1);
        second.release();
    });

    it('invalidates tasks on source revision changes and emits one dispose receipt', () => {
        const adapter = createAdapter();
        const task = adapter.beginTask('feature', 'producer:feature');
        const initialEpoch = adapter.context.documentEpoch;
        adapter.updateSource('# changed source');
        expect(task.signal.aborted).toBe(true);
        expect(adapter.context.documentEpoch).toBe(initialEpoch);

        const dispose = adapter.dispose();
        expect(dispose?.action).toBe('dispose');
        expect(validateArticleDocumentEpochReceipt(dispose)).toBe(true);
        expect(adapter.dispose()).toBeNull();
        expect(adapter.receipts.filter(receipt => receipt.action === 'dispose')).toHaveLength(1);
    });

    it('rejects tampered task envelopes even when the changed field keeps its shape', () => {
        const adapter = createAdapter();
        const task = adapter.beginTask('outline', 'producer:outline');
        const envelope = task.accept({ outline: true }).envelope;
        expect(validateArticleDocumentTaskEnvelope({
            ...envelope,
            completedRevision: envelope.completedRevision! + 1
        })).toBe(false);
        expect(validateArticleDocumentTaskEnvelope({
            ...envelope,
            context: {
                ...envelope.context,
                documentEpoch: envelope.context.documentEpoch + 1
            }
        })).toBe(false);
        expect(validateArticleDocumentContext({
            ...envelope.context,
            sourceIdentityDigest: '0'.repeat(64)
        })).toBe(false);
    });
});
