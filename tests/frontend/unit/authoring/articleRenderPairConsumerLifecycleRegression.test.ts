import { MARKDOWN_RENDERER_VERSION } from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { shallowRef, watch } from 'vue';

import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { ArticleFsusUiRenderProducer } from '@/services/authoring/articleFsusUiRenderProducer';
import { ArticleRenderCache, type ArticleRenderProducer } from '@/services/authoring/articleRenderCache';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
const configuration = { allowLatex: true, allowMermaid: true, baseUrl: null };

function open()
{
    let source = '# Reference\n\nBody';
    let failReader = false;
    let gate: Promise<void> | null = null;
    let production: ReturnType<ArticleRenderProducer['render']> | null = null;
    let delivery: ReturnType<ArticleRenderProducer['render']> | null = null;
    const owner = createArticleDocumentContextAdapter({
        articleId: 1,
        draftId: 'article:1',
        editorSessionId: 'session:reference-consumer',
        siteScope: 'site:reference',
        userScope: 'user:reference',
        content: source
    });
    const producer = new ArticleFsusUiRenderProducer(() =>
    {
        if (failReader)
        {
            throw new Error('test-source-reader-unavailable');
        }
        return source;
    }, configuration, 65536);
    // Control delivery timing only; every successful result, verification and release is canonical.
    const controlled: ArticleRenderProducer = {
        render: request =>
        {
            production = producer.render(request);
            delivery = production.then(async result =>
            {
                if (gate)
                {
                    await gate;
                }
                return result;
            });
            return delivery;
        },
        verify: (request, result) => producer.verify(request, result),
        release: ref => producer.release(ref)
    };
    const identity = {
        rendererVersion: MARKDOWN_RENDERER_VERSION,
        projectionVersion: MARKDOWN_RENDERER_VERSION,
        featureConfigurationDigest: digest(configuration),
        themeDigest: digest({ theme: 'light' }),
        locale: 'zh-CN'
    };
    const cache = new ArticleRenderCache(owner, identity, controlled,
        { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 16 });
    const resolveCurrent = () => cache.state.content === null ? null : producer.resolve(cache.state.content.result);
    cleanups.push(() =>
    {
        cache.dispose();
        owner.dispose();
    });
    return { owner, producer, cache, identity, resolveCurrent,
        production: () => production,
        delivery: () => delivery,
        source: () => source,
        update: (next: string) =>
        {
            source = next;
            owner.updateSource(source);
        },
        fail: (value: boolean) => { failReader = value; },
        delay: (value: Promise<void> | null) => { gate = value; }
    };
}

describe('ordinary retained public pair consumer lifecycle regressions', () =>
{
    it('does not retrigger a shallow consumer through stale, failed and canceled refresh reads', async () =>
    {
        const f = open();
        expect((await f.cache.refresh()).status).toBe('committed');
        const first = f.resolveCurrent()!;
        expect(first).not.toBeNull();
        const consumed = shallowRef(first);
        let replacements = 0;
        const stop = watch(consumed, () => replacements++, { flush: 'sync' });
        cleanups.push(stop);
        const sample = () =>
        {
            const pair = f.resolveCurrent();
            expect(pair).toBe(first);
            consumed.value = pair!;
            expect(replacements).toBe(0);
        };
        sample();
        f.update(f.source() + '\n\nEdited');
        expect(f.cache.state.stale).toBe(true);
        sample();
        f.fail(true);
        expect((await f.cache.refresh()).status).toBe('failed');
        sample();
        f.fail(false);
        let release!: () => void;
        f.delay(new Promise<void>(resolve => { release = resolve; }));
        const pending = f.cache.refresh();
        await Promise.resolve();
        const lateResult = await f.production()!;
        expect(lateResult.resultRef).not.toBeNull();
        expect(f.producer.resolve(lateResult)).not.toBeNull();
        f.cache.cancel();
        expect((await pending).status).toBe('canceled');
        sample();
        release();
        await f.delivery();
        f.delay(null);
        await Promise.resolve();
        expect(f.producer.resolve(lateResult)).toBeNull();
        sample();
        expect((await f.cache.refresh()).status).toBe('committed');
        const next = f.resolveCurrent()!;
        expect(next).not.toBe(first);
        consumed.value = next;
        expect(replacements).toBe(1);
        expect(next.render.rawSource).toBe(f.source());
        expect(first.render.rawSource).toBe('# Reference\n\nBody');
        for (let read = 0; read < 3; read++)
        {
            consumed.value = f.resolveCurrent()!;
        }
        expect(replacements).toBe(1);
    });

    it('invalidates a released pair on render identity replacement even when source and owner stay fixed', async () =>
    {
        const f = open();
        expect((await f.cache.refresh()).status).toBe('committed');
        const context = f.owner.context;
        const oldResult = f.cache.state.content!.result;
        const oldPair = f.resolveCurrent()!;
        f.cache.setIdentity({ ...f.identity });
        expect(f.resolveCurrent()).toBe(oldPair);
        f.cache.setIdentity({ ...f.identity, themeDigest: digest({ theme: 'dark' }) });
        expect(f.resolveCurrent()).toBeNull();
        expect(f.producer.resolve(oldResult)).toBeNull();
        expect(f.owner.context).toEqual(context);
        expect((await f.cache.refresh()).status).toBe('committed');
        const next = f.resolveCurrent()!;
        expect(next).not.toBe(oldPair);
        expect(next.render.rawSource).toBe(oldPair.render.rawSource);
        expect(f.resolveCurrent()).toBe(next);
        f.owner.dispose();
        expect(f.resolveCurrent()).toBeNull();
        expect(f.producer.resolve(f.cache.receipts.at(-1)?.result ?? oldResult)).toBeNull();
    });

    it('keeps independent producer ownership when one same-byte session is replaced', async () =>
    {
        const left = open();
        const right = open();
        expect((await left.cache.refresh()).status).toBe('committed');
        expect((await right.cache.refresh()).status).toBe('committed');
        const leftResult = left.cache.state.content!.result;
        const rightResult = right.cache.state.content!.result;
        const leftPair = left.resolveCurrent()!;
        const rightPair = right.resolveCurrent()!;
        expect(leftPair).not.toBe(rightPair);
        expect(leftPair.render.rawSource).toBe(rightPair.render.rawSource);
        left.owner.switchDocument({ articleId: 2, draftId: 'article:2', content: left.source() });
        expect(left.resolveCurrent()).toBeNull();
        expect(left.producer.resolve(leftResult)).toBeNull();
        expect(right.resolveCurrent()).toBe(rightPair);
        expect(right.producer.resolve(rightResult)).toBe(rightPair);
        expect((await left.cache.refresh()).status).toBe('committed');
        const replacement = left.resolveCurrent()!;
        expect(replacement).not.toBe(leftPair);
        expect(left.resolveCurrent()).toBe(replacement);
        expect(right.resolveCurrent()).toBe(rightPair);
        left.cache.dispose();
        expect(right.resolveCurrent()).toBe(rightPair);
    });
});
