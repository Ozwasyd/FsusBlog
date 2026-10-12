import { describe, expect, it, vi } from 'vitest';
import { MARKDOWN_RENDERER_VERSION } from '@/fsusui/markdown';
import {
    ArticleRenderCache, createArticleDocumentContextAdapter, calculateOpenArticleDocumentDigest as digest,
    validateArticleRenderCacheEntry, validateArticleRenderReceipt, validateArticleRenderState,
    evaluateArticleRenderRefreshPolicy, articleRenderSourceByteLimit,
    type ArticleRenderIdentity, type ArticleRenderProducer, type ArticleRenderRequest, type ArticleRenderResult
} from '@/services/authoring';

const identity: ArticleRenderIdentity = {
    rendererVersion: 'renderer:v1', projectionVersion: MARKDOWN_RENDERER_VERSION,
    featureConfigurationDigest: digest({ latex: true }), themeDigest: digest({ theme: 'light' }), locale: 'zh-CN'
};
const resultFor = (request: ArticleRenderRequest, overrides: Partial<ArticleRenderResult> = {}): ArticleRenderResult => ({
    contextDigest: request.context.contextDigest, requestId: request.requestId, identity: request.identity,
    status: 'valid', resultRef: `result:${request.context.documentId}:${request.requestId}`,
    resultDigest: digest({ context: request.context.contextDigest }), reason: null,
    fallbackRefs: [], longTaskRefs: ['observation:long-task'], layoutObservationRefs: ['observation:layout'], ...overrides
});
const deferred = <T>() =>
{
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
};
const setup = (maxEntryBytes = 65536, maxAgeMs = 1000) =>
{
    const adapter = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:test',
        siteScope: 'site:test', userScope: 'user:test', content: '# source' });
    const producer: ArticleRenderProducer = {
        render: vi.fn(async request => resultFor(request)), verify: vi.fn(() => true), release: vi.fn()
    };
    let now = 10;
    const cache = new ArticleRenderCache(adapter, identity, producer, { maxEntryBytes, maxAgeMs, maxReceipts: 3 }, () => now);
    return { adapter, producer, cache, advance: (value: number) => { now += value; } };
};

// Synthetic producers exercise admission; actual FsusUI consumption is a separate suite.
describe('ArticleRenderCache (#2245)', () => {
    it('first noresult uses loading/source fallback and commits a sealed identity-bound reference', async () => {
        const { adapter, cache } = setup();
        expect(cache.state.content).toBeNull();
        expect(cache.state.fallback).toBe('source');
        const pending = cache.refresh();
        expect(cache.state.fallback).toBe('loading');
        const receipt = await pending;
        expect(receipt.status).toBe('committed');
        expect(validateArticleRenderReceipt(receipt)).toBe(true);
        expect(cache.state.content?.context).toEqual(adapter.context);
        expect(validateArticleRenderCacheEntry(cache.state.content)).toBe(true);
        expect(cache.state.fallback).toBeNull();
        expect(Object.isFrozen(cache.state.content?.result.identity)).toBe(true);
        expect(receipt.result?.longTaskRefs).toEqual(['observation:long-task']);
    });
    it.each([
        ['a'.repeat(articleRenderSourceByteLimit - 1), true],
        ['a'.repeat(articleRenderSourceByteLimit), true],
        ['a'.repeat(articleRenderSourceByteLimit + 1), false],
        ['\n'.repeat(3000), false]
    ] as const)(
        'consumes canonical threshold decision (%#) without replacing last-valid', async (source, allowed) => {
            const { adapter, cache, producer } = setup();
            await cache.refresh();
            const content = cache.state.content;
            adapter.updateSource(source);
            const decision = evaluateArticleRenderRefreshPolicy(adapter.context, source);
            expect(decision.allowed).toBe(allowed);
            const receipt = await cache.autoRefresh(decision);
            expect(producer.render).toHaveBeenCalledTimes(allowed ? 2 : 1);
            if (!allowed)
            {
                expect(receipt).toBeNull();
                expect(cache.state.content).toBe(content);
                expect(cache.state.stale).toBe(true);
                expect(cache.state.fallback).toBeNull();
                expect(cache.state.reason).toBe(decision.reason);
                expect(cache.state.cachedRevision).toBe(0);
                expect(cache.state.currentRevision).toBe(1);
                expect(cache.state.lastValidTime).toBe(10);
            }
        }
    );
    it('failure keeps content and reason; retry commits the current revision', async () => {
        const { cache, adapter, producer } = setup();
        await cache.refresh();
        const content = cache.state.content;
        adapter.updateSource('# changed');
        vi.mocked(producer.render).mockRejectedValueOnce(new Error('private detail not copied'));
        const failed = await cache.refresh();
        expect(failed.status).toBe('failed');
        expect(validateArticleRenderReceipt(failed)).toBe(true);
        expect(cache.state.content).toBe(content);
        expect(cache.state.failure).toBe('render-producer-failed');
        expect(cache.state.actionIds).toContain('render-retry');
        expect((await cache.refresh()).status).toBe('committed');
        expect(cache.state.cachedRevision).toBe(1);
        expect(cache.state.stale).toBe(false);
        expect(producer.release).toHaveBeenCalledWith(content!.result.resultRef);
    });
    it('cancel completes promptly with an abort-ignoring producer; late result is released', async () => {
        const { cache, producer } = setup();
        await cache.refresh();
        const content = cache.state.content;
        const late = deferred<ArticleRenderResult>();
        let request!: ArticleRenderRequest;
        vi.mocked(producer.render).mockImplementationOnce(input => { request = input; return late.promise; });
        const pending = cache.refresh();
        await Promise.resolve();
        cache.cancel();
        const canceled = await pending;
        expect(request.signal.aborted).toBe(true);
        expect(canceled.status).toBe('canceled');
        expect(validateArticleRenderReceipt(canceled)).toBe(true);
        expect(cache.state.content).toBe(content);
        expect(cache.state.refreshState).toBe('canceled');
        late.resolve(resultFor(request));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(producer.release).toHaveBeenCalledWith(resultFor(request).resultRef);
        expect(cache.state.content).toBe(content);
        expect((await cache.refresh()).status).toBe('committed');
    });
    it.each(['revision', 'epoch', 'identity', 'request'] as const)('rejects late results after rapid %s changes', async change => {
        const { adapter, cache, producer } = setup();
        const late = deferred<ArticleRenderResult>();
        let oldRequest!: ArticleRenderRequest;
        vi.mocked(producer.render).mockImplementationOnce(input => { oldRequest = input; return late.promise; });
        const old = cache.refresh();
        await Promise.resolve();
        if (change === 'revision') adapter.updateSource('# next');
        if (change === 'epoch') adapter.switchDocument({ articleId: 2, draftId: 'article:2', content: '# source' });
        if (change === 'identity') cache.setIdentity({ ...identity, locale: 'en-US' });
        const current = await cache.refresh();
        expect(current.status).toBe('committed');
        const content = cache.state.content;
        late.resolve(resultFor(oldRequest));
        expect((await old).status).toBe('canceled');
        expect(oldRequest.signal.aborted).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(cache.state.content).toBe(content);
        expect(cache.state.refreshState).toBe('idle');
    });
    it.each(['article', 'draft', 'user', 'site'] as const)('never flashes identical-source old content across %s switch', async change => {
        const { adapter, cache, producer } = setup();
        await cache.refresh();
        const old = cache.state.content!;
        adapter.switchDocument({ articleId: change === 'article' ? 2 : 1, draftId: change === 'draft' ? 'draft:next' : 'article:1',
            content: '# source', userScope: change === 'user' ? 'user:next' : 'user:test', siteScope: change === 'site' ? 'site:next' : 'site:test' });
        expect(adapter.context.contentDigest).toBe(old.context.contentDigest);
        expect(cache.state.content).toBeNull();
        expect(cache.state.stale).toBe(false);
        expect(cache.state.fallback).toBe('source');
        expect(producer.release).toHaveBeenCalledWith(old.result.resultRef);
        await cache.refresh();
        expect(cache.state.content?.context.documentEpoch).not.toBe(old.context.documentEpoch);
    });
    it.each(['rendererVersion', 'projectionVersion', 'featureConfigurationDigest', 'themeDigest', 'locale'] as const)(
        'invalidates %s drift instead of stale reuse', async key => {
            const { cache, producer } = setup();
            await cache.refresh();
            const oldRef = cache.state.content!.result.resultRef;
            cache.setIdentity({ ...identity, [key]: key.endsWith('Digest') ? 'f'.repeat(64) : 'changed:v2' });
            expect(cache.state.content).toBeNull();
            expect(cache.state.stale).toBe(false);
            expect(producer.release).toHaveBeenCalledWith(oldRef);
        }
    );
    it('partial fallback retains content; fatal/projection failure preserves last-valid', async () => {
        const { cache, adapter, producer } = setup();
        vi.mocked(producer.render).mockImplementationOnce(async request => resultFor(request, {
            status: 'partial', reason: 'feature-node-error', fallbackRefs: ['fsusui:node-fallback']
        }));
        expect((await cache.refresh()).status).toBe('committed');
        const content = cache.state.content;
        expect(content?.result.fallbackRefs).toEqual(['fsusui:node-fallback']);
        adapter.updateSource('# changed');
        for (const status of ['fatal', 'projection-failed'] as const)
        {
            vi.mocked(producer.render).mockImplementationOnce(async request => resultFor(request, {
                status, resultRef: null, resultDigest: null, reason: 'capability-unavailable'
            }));
            expect((await cache.refresh()).status).toBe('failed');
            expect(cache.state.content).toBe(content);
            expect(cache.state.failure).toBe('capability-unavailable');
            expect(cache.state.fallback).toBeNull();
        }
    });
    it('bounds bytes, age, receipts and disposal and releases references', async () => {
        const tiny = setup(1);
        expect((await tiny.cache.refresh()).reason).toBe('cache-size-limit');
        expect(tiny.cache.state.content).toBeNull();
        expect(tiny.producer.release).toHaveBeenCalled();
        const { cache, advance, adapter, producer } = setup();
        for (let index = 0; index < 8; index++) await cache.refresh();
        expect(cache.receipts).toHaveLength(3);
        const entry = cache.state.content!;
        advance(1000);
        expect(cache.state.content).toBeNull();
        expect(producer.release).toHaveBeenCalledWith(entry.result.resultRef);
        await cache.refresh();
        adapter.dispose();
        expect(cache.state.content).toBeNull();
        expect(cache.receipts).toEqual([]);
        expect(cache.state.actionIds).toEqual([]);
        await expect(cache.refresh()).rejects.toThrow('disposed');
    });
    it('draft revision drift is invalid rather than stale', async () => {
        const { adapter, cache } = setup();
        await cache.refresh();
        adapter.updateDraftRevision('server:2');
        expect(cache.state.content).toBeNull();
        expect(cache.state.stale).toBe(false);
    });
    it('rejects notice-replaces-render state mutation and rechecks retained result integrity', async () => {
        const { adapter, cache, producer } = setup();
        await cache.refresh();
        adapter.updateSource('# next');
        const state = cache.state;
        expect(validateArticleRenderState(state)).toBe(true);
        expect(validateArticleRenderState({ ...state, content: null, fallback: 'source' })).toBe(false);
        expect(validateArticleRenderState({ ...state, html: '<p>second authority</p>' })).toBe(false);
        vi.mocked(producer.verify).mockReturnValue(false);
        expect(cache.state.content).toBeNull();
        expect(producer.release).toHaveBeenCalled();
    });
    it('releases a produced reference if verification throws or invalidates the task before commit', async () => {
        for (const mode of ['throw', 'switch'] as const)
        {
            const { cache, adapter, producer } = setup();
            vi.mocked(producer.verify).mockImplementationOnce(() => {
                if (mode === 'throw') throw new Error('verification-failed');
                adapter.updateSource('# next');
                return true;
            });
            const receipt = await cache.refresh();
            expect(receipt.status).not.toBe('committed');
            expect(cache.state.content).toBeNull();
            expect(producer.release).toHaveBeenCalledTimes(1);
            expect(adapter.activeTaskRefs).toEqual([]);
        }
    });
    it('rejects a null producer result as invalid rather than treating it as cancellation', async () => {
        const { cache, producer, adapter } = setup();
        await cache.refresh();
        const previous = cache.state.content;
        vi.mocked(producer.render).mockResolvedValueOnce(null as unknown as ArticleRenderResult);
        const receipt = await cache.refresh();
        expect(receipt.status).toBe('rejected');
        expect(receipt.reason).toBe('render-result-invalid');
        expect(validateArticleRenderReceipt(receipt)).toBe(true);
        expect(cache.state.content).toBe(previous);
        expect(cache.state.refreshState).toBe('failed');
        expect(adapter.activeTaskRefs).toEqual([]);
    });
    it('falls back explicitly when retained-result verification throws and permits retry', async () => {
        const { cache, producer } = setup();
        await cache.refresh();
        const previousRef = cache.state.content!.result.resultRef;
        vi.mocked(producer.verify).mockImplementationOnce(() => { throw new Error('retained-result-invalid'); });
        const state = cache.state;
        expect(state.content).toBeNull();
        expect(state.fallback).toBe('source');
        expect(state.failure).toBe('render-cache-verification-failed');
        expect(state.actionIds).toContain('render-retry');
        expect(validateArticleRenderState(state)).toBe(true);
        expect(producer.release).toHaveBeenCalledWith(previousRef);
        expect((await cache.refresh()).status).toBe('committed');
    });
    it('keeps an active refresh cancelable when retained-result verification throws', async () => {
        const { cache, producer } = setup();
        await cache.refresh();
        const late = deferred<ArticleRenderResult>();
        let request!: ArticleRenderRequest;
        vi.mocked(producer.render).mockImplementationOnce(input => { request = input; return late.promise; });
        const pending = cache.refresh();
        await Promise.resolve();
        vi.mocked(producer.verify).mockImplementationOnce(() => { throw new Error('retained-result-invalid'); });
        const state = cache.state;
        expect(state.content).toBeNull();
        expect(state.fallback).toBe('loading');
        expect(state.refreshState).toBe('running');
        expect(state.actionIds).toEqual(['render-cancel']);
        expect(validateArticleRenderState(state)).toBe(true);
        cache.cancel();
        expect((await pending).status).toBe('canceled');
        late.resolve(resultFor(request));
        await vi.waitFor(() => expect(producer.release).toHaveBeenCalledWith(resultFor(request).resultRef));
        expect(cache.state.content).toBeNull();
    });
    it.each(['context', 'request', 'feature', 'authority', 'html', 'partial-without-fallback'] as const)(
        'rejects %s mutation without replacing old valid content', async mutation => {
            const { cache, adapter, producer } = setup();
            await cache.refresh();
            const content = cache.state.content;
            adapter.updateSource('# next');
            vi.mocked(producer.render).mockImplementationOnce(async request => {
                const result = resultFor(request);
                if (mutation === 'context') return { ...result, contextDigest: 'f'.repeat(64) };
                if (mutation === 'request') return { ...result, requestId: 'request:forged' };
                if (mutation === 'feature') return { ...result, identity: { ...identity, themeDigest: 'f'.repeat(64) } };
                if (mutation === 'html') return { ...result, html: '<p>second body authority</p>' };
                if (mutation === 'partial-without-fallback') return { ...result, status: 'partial', reason: 'error' };
                return result;
            });
            if (mutation === 'authority') vi.mocked(producer.verify).mockReturnValueOnce(false);
            const receipt = await cache.refresh();
            expect(receipt.status).toBe('rejected');
            expect(cache.state.content).toBe(content);
            expect(validateArticleRenderReceipt(receipt)).toBe(true);
        }
    );
    it('independent verifier detects every cache/receipt field tamper and re-digested identity substitution', async () => {
        const { cache } = setup();
        const receipt = await cache.refresh();
        const content = cache.state.content!;
        for (const key of Object.keys(content)) expect(validateArticleRenderCacheEntry({ ...content, [key]: 'tampered' })).toBe(false);
        for (const key of Object.keys(receipt)) expect(validateArticleRenderReceipt({ ...receipt, [key]: 'tampered' })).toBe(false);
        expect(validateArticleRenderCacheEntry({ ...content, html: '<p>authority</p>' })).toBe(false);
        const { cacheDigest: _cacheDigest, ...unsigned } = content;
        void _cacheDigest;
        const forged = { ...unsigned, identity: { ...identity, locale: 'en-US' } };
        expect(validateArticleRenderCacheEntry({ ...forged, cacheDigest: digest(forged) })).toBe(false);
        const { receiptDigest: _receiptDigest, ...unsignedReceipt } = receipt;
        void _receiptDigest;
        const forgedReceipt = { ...unsignedReceipt, result: { ...receipt.result!, requestId: 'request:forged' } };
        expect(validateArticleRenderReceipt({ ...forgedReceipt, receiptDigest: digest(forgedReceipt) })).toBe(false);
    });
});

// Source controls only: runtime/test/list execution remains HOLD.
describe('original render future and cleanup settlement (#2245)', () =>
{
    it('settles the original lease after accepted render transfer, not merely its receipt', async () =>
    {
        const { adapter, cache } = setup();
        const work = cache.startRefresh();
        expect(adapter.pendingTaskRefs).toContain(work.taskRef);
        expect(cache.pendingRefreshWork).toContain(work);
        expect((await work.receipt).status).toBe('committed');
        await work.terminal;
        expect(adapter.pendingTaskRefs).not.toContain(work.taskRef);
        expect(cache.pendingRefreshWork).not.toContain(work);
        expect(cache.state.content?.result.resultRef).toBe(work.resultRef);
    });

    it('keeps aborted/disposed work pending until the actual late result has been released', async () =>
    {
        const { adapter, cache, producer } = setup();
        const late = deferred<ArticleRenderResult>();
        let request!: ArticleRenderRequest;
        vi.mocked(producer.render).mockImplementationOnce(input => { request = input; return late.promise; });
        const work = cache.startRefresh();
        await Promise.resolve();
        cache.dispose();
        expect((await work.receipt).status).toBe('canceled');
        expect(adapter.pendingTaskRefs).toContain(work.taskRef);
        expect(cache.pendingRefreshWork).toContain(work);
        expect(producer.release).not.toHaveBeenCalled();
        late.resolve(resultFor(request));
        await work.terminal;
        expect(producer.release).toHaveBeenCalledExactlyOnceWith(work.resultRef);
        expect(adapter.pendingTaskRefs).not.toContain(work.taskRef);
        expect(cache.pendingRefreshWork).toEqual([]);
    });

    it('retains the failed late release and original obligation without retry or fake settlement', async () =>
    {
        const { adapter, cache, producer } = setup();
        const late = deferred<ArticleRenderResult>();
        let request!: ArticleRenderRequest;
        vi.mocked(producer.render).mockImplementationOnce(input => { request = input; return late.promise; });
        vi.mocked(producer.release).mockImplementationOnce(() => { throw new Error('actual-release-failure'); });
        const work = cache.startRefresh();
        await Promise.resolve();
        cache.cancel();
        await work.receipt;
        late.resolve(resultFor(request));
        await expect(work.terminal).rejects.toThrow('actual-release-failure');
        expect(work.cleanupFailure).not.toBeNull();
        expect(work.resultRef).toBe(resultFor(request).resultRef);
        cache.dispose();
        expect(adapter.pendingTaskRefs).toContain(work.taskRef);
        expect(cache.pendingRefreshWork).toContain(work);
        expect(producer.release).toHaveBeenCalledTimes(1);
    });

    it('preserves an earlier unfinished generation after a newer generation truly settles', async () =>
    {
        const { adapter, cache, producer } = setup();
        const late = deferred<ArticleRenderResult>();
        let request!: ArticleRenderRequest;
        vi.mocked(producer.render).mockImplementationOnce(input => { request = input; return late.promise; });
        const first = cache.startRefresh();
        await Promise.resolve();
        const second = cache.startRefresh();
        expect((await first.receipt).status).toBe('canceled');
        await second.terminal;
        expect(adapter.pendingTaskRefs).toContain(first.taskRef);
        expect(adapter.pendingTaskRefs).not.toContain(second.taskRef);
        expect(cache.pendingRefreshWork).toEqual([first]);
        late.resolve(resultFor(request));
        await first.terminal;
        expect(producer.release).toHaveBeenCalledExactlyOnceWith(first.resultRef);
        expect(cache.state.content?.result.resultRef).toBe(second.resultRef);
    });

    it('keeps a rejected producer future pending when its failure cleanup endpoint is unconfirmed', async () =>
    {
        const { adapter, cache, producer } = setup();
        vi.mocked(producer.render).mockRejectedValueOnce(new Error('actual-render-rejection'));
        const work = cache.startRefresh();
        expect((await work.receipt).status).toBe('failed');
        await expect(work.terminal).rejects.toThrow('article-render-producer-terminal-unconfirmed');
        expect(work.producerFailure).not.toBeNull();
        expect(adapter.pendingTaskRefs).toContain(work.taskRef);
        expect(cache.pendingRefreshWork).toContain(work);
        expect(producer.release).not.toHaveBeenCalled();
    });

    it('retains the old entry when replacement release fails and leaves new work pending', async () =>
    {
        const { adapter, cache, producer } = setup();
        await cache.startRefresh().terminal;
        const original = cache.state.content;
        adapter.updateSource('# replacement');
        vi.mocked(producer.release).mockImplementationOnce(() => { throw new Error('old-entry-release-failure'); });
        const replacement = cache.startRefresh();
        expect((await replacement.receipt).status).toBe('failed');
        await expect(replacement.terminal).rejects.toThrow('article-render-cleanup-failed');
        expect(cache.state.content).toBe(original);
        expect(adapter.pendingTaskRefs).toContain(replacement.taskRef);
        expect(cache.pendingRefreshWork).toContain(replacement);
        expect(producer.release).toHaveBeenCalledTimes(2);
        expect(() => cache.dispose()).toThrow('article-render-entry-release-failed');
        expect(adapter.pendingTaskRefs).toContain(replacement.taskRef);
    });

    it('rejects an undeclared cleanup future without dropping it or settling the original lease', async () =>
    {
        const { adapter, cache, producer } = setup();
        const cleanup = deferred<void>();
        producer.release = vi.fn(() => cleanup.promise);
        vi.mocked(producer.render).mockImplementationOnce(async request => resultFor(request, { requestId: 'foreign-request' }));
        const work = cache.startRefresh();
        await work.receipt;
        await expect(work.terminal).rejects.toThrow('article-render-cleanup-failed');
        const actualFailure = work.cleanupFailure?.cause;
        expect(actualFailure).toBeInstanceOf(Error);
        if (!(actualFailure instanceof Error))
        {
            throw new Error('missing-original-cleanup-failure');
        }
        expect(actualFailure.cause).toBe(cleanup.promise);
        expect(adapter.pendingTaskRefs).toContain(work.taskRef);
        cleanup.resolve();
        await cleanup.promise;
        expect(cache.pendingRefreshWork).toContain(work);
        expect(adapter.pendingTaskRefs).toContain(work.taskRef);
    });

    it('rejects commit when the actual release callback changes the original context', async () =>
    {
        const { adapter, cache, producer } = setup();
        await cache.startRefresh().terminal;
        adapter.updateSource('# replacement');
        vi.mocked(producer.release).mockImplementationOnce(() => { adapter.updateSource('# release callback revision'); });
        const replacement = cache.startRefresh();
        expect((await replacement.receipt).status).toBe('rejected');
        await replacement.terminal;
        expect(cache.state.content).toBeNull();
        expect(adapter.pendingTaskRefs).not.toContain(replacement.taskRef);
        expect(producer.release).toHaveBeenCalledTimes(2);
    });


    it('retains a producer result with an unusable cleanup reference rather than assuming no resource', async () =>
    {
        const { adapter, cache, producer } = setup();
        vi.mocked(producer.render).mockImplementationOnce(async request => resultFor(request, { resultRef: 'invalid ref' }));
        const work = cache.startRefresh();
        expect((await work.receipt).status).toBe('failed');
        await expect(work.terminal).rejects.toThrow('article-render-cleanup-reference-invalid');
        expect(work.cleanupFailure).not.toBeNull();
        expect(cache.pendingRefreshWork).toContain(work);
        expect(adapter.pendingTaskRefs).toContain(work.taskRef);
        expect(producer.release).not.toHaveBeenCalled();
    });

});
