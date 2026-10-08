import { describe, expect, it } from 'vitest';
import { MARKDOWN_RENDERER_VERSION } from '@ozwasyd/element-plus/markdown-runtime';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { ArticleFsusUiRenderProducer } from '@/services/authoring/articleFsusUiRenderProducer';
import { ArticleRenderCache, validateArticleRenderReceipt, type ArticleRenderProducer } from '@/services/authoring/articleRenderCache';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

// Native Node renderer/cache proof complements the mounted public editor proofs.
// It does not claim rendered UI, focus, viewport or browser Wasm acceptance.
describe('continuity prerequisite current native canonical renderer/cache', () =>
{
    it('retains actual stale last-valid content through failed/canceled refresh and retry, then isolates same-source articles', async () => {
        let source = '# Heading\n\nabcdef'; let fail = false; let wait: Promise<void> | null = null;
        const owner = createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1', editorSessionId: 'session:continuity-render',
            siteScope: 'site:test', userScope: 'user:test', content: source });
        const configuration = { allowLatex: true, allowMermaid: true, baseUrl: null };
        const producer = new ArticleFsusUiRenderProducer(() => {
            if (fail) throw new Error('isolated-source-reader-failure');
            return source;
        }, configuration, 65536);
        const controlled: ArticleRenderProducer = {
            render: async request => { if (wait) await wait; return producer.render(request); },
            verify: (request, result) => producer.verify(request, result), release: ref => producer.release(ref)
        };
        const cache = new ArticleRenderCache(owner, { rendererVersion: MARKDOWN_RENDERER_VERSION, projectionVersion: MARKDOWN_RENDERER_VERSION,
            featureConfigurationDigest: digest(configuration), themeDigest: digest({ theme: 'light' }), locale: 'zh-CN' }, controlled,
        { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 });
        try
        {
            const initial = await cache.refresh(); expect(initial.status).toBe('committed'); expect(validateArticleRenderReceipt(initial)).toBe(true);
            const retained = cache.state.content!.result;
            expect(producer.resolve(retained)!.render.html).toContain('Heading');
            source += '!'; owner.updateSource(source);
            expect(cache.state).toMatchObject({ stale: true, cachedRevision: 0, currentRevision: 1 });
            fail = true;
            expect((await cache.refresh()).status).toBe('failed'); expect(cache.state.content!.result).toEqual(retained);
            let release!: () => void; wait = new Promise<void>(resolve => { release = resolve; });
            const running = cache.refresh(); cache.cancel();
            expect((await running).status).toBe('canceled'); expect(cache.state.content!.result).toEqual(retained);
            release(); wait = null; fail = false;
            const retried = await cache.refresh(); expect(retried.status).toBe('committed'); expect(validateArticleRenderReceipt(retried)).toBe(true);
            expect(cache.state).toMatchObject({ stale: false, cachedRevision: 1, currentRevision: 1 });
            expect(producer.resolve(cache.state.content!.result)!.render.rawSource).toBe(source);
            owner.switchDocument({ articleId: 2, draftId: 'article:2', content: source });
            expect(cache.state.content).toBeNull(); expect(producer.resolve(retained)).toBeNull();
            expect((await cache.refresh()).status).toBe('committed'); expect(cache.state.content!.context.articleId).toBe(2);
        }
        finally { cache.dispose(); owner.dispose(); }
    });
});
