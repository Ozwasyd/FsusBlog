import { describe, expect, it } from 'vitest';
import {
    MARKDOWN_RENDERER_VERSION,
    createMarkdownEditorProjection,
    createMarkdownOutlineEntries,
    markdownRenderIdentitiesEqual,
    resolveMarkdownSourceIdentity,
    stabilizeMarkdownEditorProjection,
    renderMarkdownResultWithRuntime
} from '@ozwasyd/element-plus/markdown-runtime';
import { ArticleFsusUiRenderProducer } from '@/services/authoring/articleFsusUiRenderProducer';
import {
    ArticleRenderCache, createArticleDocumentContextAdapter, calculateOpenArticleDocumentDigest as digest,
    validateArticleRenderReceipt, evaluateArticleRenderRefreshPolicy, articleRenderSourceByteLimit,
    type ArticleRenderIdentity, type ArticleRenderRequest
} from '@/services/authoring';

const configuration = { allowLatex: true, allowMermaid: true, baseUrl: null };
const identity: ArticleRenderIdentity = {
    rendererVersion: MARKDOWN_RENDERER_VERSION, projectionVersion: MARKDOWN_RENDERER_VERSION,
    featureConfigurationDigest: digest(configuration), themeDigest: digest({ theme: 'light' }), locale: 'zh-CN'
};
const setup = (initialSource = '# Article\n\nBody', maxResultBytes = 65536) =>
{
    let source = initialSource;
    const adapter = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:consumer',
        siteScope: 'site:consumer', userScope: 'user:consumer', content: source });
    const producer = new ArticleFsusUiRenderProducer(() => source, configuration, maxResultBytes);
    const cache = new ArticleRenderCache(adapter, identity, producer,
        { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 });
    return { cache, adapter, producer, source: () => source, update: (next: string) => { source = next; adapter.updateSource(source); } };
};

describe('actual local FsusUI public consumer boundary (#269/#273)', () => {
    // Source controls only: actual source/derived Promises, never executed under holds.
    it.each(['discard-fulfillment', 'derived-replay'] as const)(
        'retains observer custody for %s and a then getter that throws on its second read', async mode => {
            const adapter = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
                editorSessionId: `session:observer-assimilation:${mode}`, siteScope: 'site:consumer', userScope: 'user:consumer', content: '# Article' });
            let actualRequest: ArticleRenderRequest | null = null;
            let fulfil!: (value: unknown) => void;
            let finishFailure!: () => void;
            let thenReads = 0;
            const sourceFuture = new Promise<unknown>(resolve => { fulfil = resolve; });
            const failureFuture = new Promise<void>(resolve => { finishFailure = resolve; });
            const value = Object.defineProperty({}, 'then', { get: () => {
                thenReads += 1;
                if (thenReads === 1) return undefined;
                throw failureFuture;
            } });
            let actualDerived: Promise<unknown> | null = null;
            if (mode === 'derived-replay') {
                // A real species capability replays the fulfilled object into a native
                // derived Promise, forcing asynchronous assimilation despite the no-op.
                Object.defineProperty(sourceFuture, 'constructor', { value: {
                    [Symbol.species]: function (executor: (resolve: (value: unknown) => void, reject: (cause: unknown) => void) => void) {
                        const derived = new Promise<unknown>((resolve, reject) => executor(() => resolve(value), reject));
                        actualDerived = derived;
                        return derived;
                    }
                } });
            }
            const producer = new ArticleFsusUiRenderProducer(request => {
                actualRequest = request;
                throw sourceFuture;
            }, configuration, 65536);
            const cache = new ArticleRenderCache(adapter, identity, producer,
                { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 });
            const cacheWork = cache.startRefresh(); await cacheWork.receipt;
            if (!actualRequest) throw new Error('original-producer-request-missing');
            const work = producer.getRequestWork(actualRequest)!;
            await expect(work.terminal).rejects.toThrow('article-fsusui-source-cleanup-unconfirmed');
            fulfil(value);
            if (mode === 'derived-replay') {
                if (!actualDerived) throw new Error('actual-observer-derived-promise-missing');
                await expect(actualDerived).rejects.toBe(failureFuture);
                expect(work.cleanupFailure?.cause).toMatchObject({ endpointFailure: { cause: sourceFuture },
                    observerPromise: actualDerived, observationFailure: failureFuture });
                expect(thenReads).toBe(2);
            } else {
                await Promise.resolve(); await Promise.resolve();
                expect(thenReads).toBe(1);
                expect(work.cleanupFailure?.cause).toBe(sourceFuture);
            }
            expect(work.producerFailure?.cause).toBe(sourceFuture);
            await expect(work.terminal).rejects.toThrow();
            await expect(cacheWork.terminal).rejects.toThrow('article-render-producer-terminal-unconfirmed');
            finishFailure(); await failureFuture;
            expect(adapter.pendingTaskRefs).toContain(cacheWork.taskRef);
            cache.dispose(); adapter.dispose();
        });

    // Original public callback can legally throw a future (never return type); all UNRUN.
    it.each(['promise', 'thenable', 'then-getter', 'error-with-future', 'observer-failure',
        'null', 'undefined', 'string', 'number', 'symbol'] as const)(
        'keeps thrown %s source obligations unconfirmed before and after the actual future ends', async kind => {
            const adapter = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
                editorSessionId: `session:source-throw:${kind}`, siteScope: 'site:consumer', userScope: 'user:consumer', content: '# Article' });
            let actualRequest: ArticleRenderRequest | null = null;
            let finish!: () => void;
            let finishObserver!: () => void;
            let sourceEnded = false;
            let thenReads = 0;
            const future = new Promise<void>(resolve => { finish = resolve; });
            const observerFuture = new Promise<void>(resolve => { finishObserver = resolve; });
            void future.then(() => { sourceEnded = true; });
            const thenable = Object.defineProperty({}, 'then', { get: () => { thenReads += 1; throw observerFuture; } });
            const values: Record<typeof kind, unknown> = { promise: future,
                thenable: { then: () => { thenReads += 1; return future; } }, 'then-getter': thenable,
                'error-with-future': new Error('source-error-with-pending-work', { cause: future }),
                'observer-failure': future, null: null, undefined: undefined, string: 'unknown-work', number: 17, symbol: Symbol('unknown-work') };
            if (kind === 'observer-failure') {
                Object.defineProperty(future, 'constructor', { configurable: true, get: () => { throw observerFuture; } });
            }
            const thrown = values[kind];
            const producer = new ArticleFsusUiRenderProducer(request => {
                actualRequest = request;
                throw thrown;
            }, configuration, 65536);
            const cache = new ArticleRenderCache(adapter, identity, producer,
                { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 });
            const cacheWork = cache.startRefresh();
            await cacheWork.receipt;
            if (!actualRequest) throw new Error('original-producer-request-missing');
            const work = producer.getRequestWork(actualRequest)!;
            await expect(work.result).rejects.toBe(thrown);
            await expect(work.terminal).rejects.toThrow(kind === 'observer-failure'
                ? 'article-fsusui-rejection-observer-unconfirmed' : 'article-fsusui-source-cleanup-unconfirmed');
            expect(work.producerFailure?.cause).toBe(thrown);
            if (kind === 'observer-failure') {
                expect(work.cleanupFailure?.cause).toMatchObject({ endpointFailure: { cause: future }, observationFailure: observerFuture });
            } else {
                expect(work.cleanupFailure?.cause).toBe(thrown);
            }
            expect(thenReads).toBe(0); expect(sourceEnded).toBe(false);
            await expect(cacheWork.terminal).rejects.toThrow('article-render-producer-terminal-unconfirmed');
            if (kind === 'observer-failure') {
                Object.defineProperty(future, 'constructor', { configurable: true, value: Promise });
            }
            finish(); finishObserver(); await future; await observerFuture;
            await expect(work.terminal).rejects.toThrow();
            expect(adapter.pendingTaskRefs).toContain(cacheWork.taskRef);
            cache.dispose(); adapter.dispose();
        });

    it.each(['return-source', 'throw-future'] as const)('preserves actual disposal reentry with %s', async outcome => {
        const adapter = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
            editorSessionId: `session:source-disposal:${outcome}`, siteScope: 'site:consumer', userScope: 'user:consumer', content: '# Article' });
        let actualRequest: ArticleRenderRequest | null = null;
        let finish!: () => void;
        const future = new Promise<void>(resolve => { finish = resolve; });
        const producer = new ArticleFsusUiRenderProducer(request => {
            actualRequest = request;
            adapter.dispose();
            if (outcome === 'throw-future') throw future;
            return '# Article';
        }, configuration, 65536);
        const cache = new ArticleRenderCache(adapter, identity, producer,
            { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 });
        const cacheWork = cache.startRefresh(); await cacheWork.receipt;
        if (!actualRequest) throw new Error('original-producer-request-missing');
        const work = producer.getRequestWork(actualRequest)!;
        if (outcome === 'throw-future') {
            await expect(work.terminal).rejects.toThrow('article-fsusui-source-cleanup-unconfirmed');
            expect(work.cleanupFailure?.cause).toBe(future);
        } else {
            await expect(work.result).rejects.toThrow('render-canceled');
            await work.terminal;
            expect(work.cleanupFailure).toBeNull();
        }
        // Only this producer-local request is known ended; no scope/cache lease proof.
        await expect(cacheWork.terminal).rejects.toThrow('article-render-producer-terminal-unconfirmed');
        finish(); await future;
        cache.dispose();
    });

    // Source control only: the actual constructor receives an undeclared future, UNRUN.
    it('retains an undeclared source future without treating no native call as cleanup proof', async () => {
        const adapter = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
            editorSessionId: 'session:unknown-reader', siteScope: 'site:consumer', userScope: 'user:consumer', content: '# Article' });
        let actualRequest: ArticleRenderRequest | null = null;
        let finish!: (value: string) => void;
        const sourceFuture = new Promise<string>(resolve => { finish = resolve; });
        // Deliberately invalid producer input through the original public constructor.
        const producer: ArticleFsusUiRenderProducer = Reflect.construct(ArticleFsusUiRenderProducer,
            [(request: ArticleRenderRequest) => { actualRequest = request; return sourceFuture; }, configuration, 65536]);
        const cache = new ArticleRenderCache(adapter, identity, producer,
            { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 });
        const cacheWork = cache.startRefresh();
        await cacheWork.receipt;
        if (!actualRequest) throw new Error('original-producer-request-missing');
        const work = producer.getRequestWork(actualRequest)!;
        await expect(work.terminal).rejects.toThrow('article-fsusui-source-endpoint-missing');
        expect(work.cleanupFailure?.cause).toBe(sourceFuture);
        await expect(cacheWork.terminal).rejects.toThrow('article-render-producer-terminal-unconfirmed');
        expect(adapter.pendingTaskRefs).toContain(cacheWork.taskRef);
        finish('# Article'); await sourceFuture;
        // A missing declared endpoint is not silently reinterpreted after it resolves.
        await expect(work.terminal).rejects.toThrow('article-fsusui-source-endpoint-missing');
        cache.dispose(); adapter.dispose();
    });

    // Source control only: UNRUN under current runtime/test/list/native holds.
    it('retains ordinary reader Error cleanup without faking producer or cache settlement', async () => {
        const adapter = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
            editorSessionId: 'session:failed-reader', siteScope: 'site:consumer', userScope: 'user:consumer', content: '# Article' });
        let actualRequest: ArticleRenderRequest | null = null;
        const failure = new Error('actual-reader-failure');
        const producer = new ArticleFsusUiRenderProducer(request => {
            actualRequest = request;
            throw failure;
        }, configuration, 65536);
        const cache = new ArticleRenderCache(adapter, identity, producer,
            { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 });
        const cacheWork = cache.startRefresh();
        const receipt = await cacheWork.receipt;
        expect(receipt.status).toBe('failed');
        if (!actualRequest) throw new Error('original-producer-request-missing');
        const work = producer.getRequestWork(actualRequest)!;
        expect(work.request).toBe(actualRequest);
        expect(producer.getRequestWork({ ...work.request })).toBeNull();
        expect(producer.startRender(actualRequest)).toBe(work);
        await expect(work.result).rejects.toBe(failure);
        await expect(work.terminal).rejects.toThrow('article-fsusui-source-cleanup-unconfirmed');
        expect(work.cleanupFailure?.cause).toBe(failure);
        expect(work.resultRef).toBeNull();
        // #2245 has not yet consumed this original producer endpoint.
        await expect(cacheWork.terminal).rejects.toThrow('article-render-producer-terminal-unconfirmed');
        expect(cache.pendingRefreshWork).toContain(cacheWork);
        expect(adapter.pendingTaskRefs).toContain(cacheWork.taskRef);
        cache.dispose(); adapter.dispose();
    });

    it('executes canonical renderer/projection and public heading tree without mocks', async () => {
        const source = '# Heading\n\nText';
        const rendered = await renderMarkdownResultWithRuntime({ source, mode: 'article' });
        expect(rendered.ok).toBe(true);
        if (!rendered.ok) throw new Error(JSON.stringify(rendered.error));
        expect(['SIMD-128', 'SCALAR-BASIC']).toContain(rendered.value.engine);
        const projection = createMarkdownEditorProjection(source);
        expect(markdownRenderIdentitiesEqual(projection, rendered.value), JSON.stringify({ projection: projection.identity, render: {
            parser: rendered.value.parser, sourceIdentity: rendered.value.sourceIdentity, rendererVersion: rendered.value.rendererVersion,
            rawSource: rendered.value.rawSource, normalizedSource: rendered.value.normalizedSource
        } })).toBe(true);
        const stable = stabilizeMarkdownEditorProjection(projection, { id: 'document:consumer', epoch: 1 });
        expect(createMarkdownOutlineEntries(stable)).toHaveLength(1);
        expect(rendered.value.html).toContain('Heading');
    });
    it('commits the actual canonical result and verifies its digest/ref before cache use', async () => {
        const { cache, producer } = setup();
        const receipt = await cache.refresh();
        expect(receipt.status).toBe('committed');
        expect(validateArticleRenderReceipt(receipt)).toBe(true);
        const result = cache.state.content!.result;
        const retained = producer.resolve(result)!;
        expect(retained.render.html).toContain('Article');
        expect(retained.projection.identity.sourceIdentity).toBe(resolveMarkdownSourceIdentity(retained.render.rawSource));
        expect(retained.render.sourceIdentity).toBe(resolveMarkdownSourceIdentity({
            source: retained.render.rawSource, mode: 'editor', ...configuration
        }));
        expect(producer.resolve({ ...result, resultDigest: 'f'.repeat(64) })).toBeNull();
        expect(result.resultDigest).toBe(digest(retained));
        expect(Object.isFrozen(retained.projection.nodes)).toBe(true);
        cache.dispose();
        expect(producer.resolve(result)).toBeNull();
    });
    it('retains one frozen public pair per admitted entry and releases it when replaced', async () => {
        const { cache, producer, update } = setup('# Article');
        expect((await cache.refresh()).status).toBe('committed');
        const firstResult = cache.state.content!.result;
        const firstPair = producer.resolve(firstResult)!;
        expect(Object.isFrozen(firstPair)).toBe(true);
        expect(producer.resolve(firstResult)).toBe(firstPair);
        expect(producer.resolve({ ...firstResult })).toBe(firstPair);
        expect(producer.resolve({ ...firstResult, resultDigest: 'f'.repeat(64) })).toBeNull();
        update('# Next article');
        expect((await cache.refresh()).status).toBe('committed');
        const nextResult = cache.state.content!.result;
        const nextPair = producer.resolve(nextResult)!;
        expect(nextPair).not.toBe(firstPair);
        expect(producer.resolve(nextResult)).toBe(nextPair);
        expect(firstPair.render.rawSource).toBe('# Article');
        expect(producer.resolve(firstResult)).toBeNull();
        cache.dispose();
        expect(producer.resolve(nextResult)).toBeNull();
    });
    it('keeps same-document stale canonical content and never exposes A to same-source B', async () => {
        const { cache, producer, adapter, update } = setup('# Article', 2000000);
        expect((await cache.refresh()).status).toBe('committed');
        const old = cache.state.content!.result;
        const next = '# Next article text\n' + 'a'.repeat(articleRenderSourceByteLimit);
        update(next);
        await cache.autoRefresh(evaluateArticleRenderRefreshPolicy(adapter.context, next));
        expect(producer.resolve(cache.state.content!.result)?.render.html).toContain('Article');
        expect(cache.state.stale).toBe(true);
        adapter.switchDocument({ articleId: 2, draftId: 'article:2', content: next });
        expect(cache.state.content).toBeNull();
        expect(producer.resolve(old)).toBeNull();
        expect((await cache.refresh()).status).toBe('committed');
        expect(producer.resolve(cache.state.content!.result)?.render.html).toContain('Next article text');
        cache.dispose();
    });
    it('preserves parser-owned malformed-node fallback instead of discarding the document', async () => {
        const { cache, producer } = setup('# Good\n\n```mermaid\ngraph TD; A-->B');
        const receipt = await cache.refresh();
        expect(receipt.status).toBe('committed');
        expect(cache.state.content!.result.status).toBe('partial');
        const result = cache.state.content!.result;
        const retained = producer.resolve(result)!;
        expect(result.fallbackRefs).toEqual([...new Set(retained.projection.diagnostics.map(item => item.blockIdentity))]);
        expect(retained.render.html).toContain('Good');
        cache.dispose();
    });
    it('rejects actual body retention overflow, source and feature/version mismatch', async () => {
        const tiny = setup('# Article', 1);
        expect((await tiny.cache.refresh()).reason).toBe('render-retention-limit');
        expect(tiny.cache.state.content).toBeNull();
        tiny.cache.dispose();
        const { cache } = setup();
        cache.setIdentity({ ...identity, featureConfigurationDigest: 'f'.repeat(64) });
        expect((await cache.refresh()).reason).toBe('render-identity-mismatch');
        cache.setIdentity({ ...identity, rendererVersion: 'unavailable:v2' });
        expect((await cache.refresh()).reason).toBe('render-identity-mismatch');
        cache.dispose();
    });
    it('accepts an empty canonical render without substituting old content', async () => {
        const { cache, producer } = setup('');
        expect(cache.state.content).toBeNull();
        expect((await cache.refresh()).status).toBe('committed');
        expect(producer.resolve(cache.state.content!.result)?.render.rawSource).toBe('');
        cache.dispose();
    });
});
