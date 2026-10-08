import { afterEach, describe, expect, it, vi } from 'vitest';
import * as markdown from '@/fsusui/markdown';
import { MARKDOWN_RENDERER_VERSION, createMarkdownEditorProjection } from '@/fsusui/markdown';
import {
    ArticleRenderCache, createArticleDocumentContextAdapter, calculateOpenArticleDocumentDigest as digest,
    evaluateArticleRenderRefreshPolicy, validateArticleRenderRefreshDecision, admitArticleRenderRefreshDecision,
    articleRenderSourceByteLimit, articleRenderEstimatedNodeLimit,
    type ArticleRenderIdentity, type ArticleRenderRefreshDecision, type ArticleRenderProducer
} from '@/services/authoring';

const setup = (source: string) => createArticleDocumentContextAdapter({ articleId: 1, draftId: 'article:1',
    editorSessionId: 'session:policy', siteScope: 'site:policy', userScope: 'user:policy', content: source });

afterEach(() => vi.restoreAllMocks());

describe('canonical article render refresh policy (#2245)', () => {
    it.each([-1, 0, 1])('measures the ASCII byte boundary at limit %+i', delta => {
        const source = 'a'.repeat(articleRenderSourceByteLimit + delta);
        const adapter = setup(source);
        const decision = evaluateArticleRenderRefreshPolicy(adapter.context, source);
        expect(decision.sourceUtf8Bytes).toBe(articleRenderSourceByteLimit + delta);
        expect(decision.byteMeasurement).toBe('exact');
        expect(decision.allowed).toBe(delta <= 0);
        expect(validateArticleRenderRefreshDecision(decision)).toBe(true);
        if (delta > 0) expect(decision.nodeMeasurement).toBe('not-run');
    });
    it.each(['中', '😀'])('uses actual UTF-8 bytes for %s and never UTF-16 length', character => {
        const source = character.repeat(articleRenderSourceByteLimit / 2);
        const decision = evaluateArticleRenderRefreshPolicy(setup(source).context, source);
        expect(source.length).toBeLessThanOrEqual(articleRenderSourceByteLimit);
        expect(decision.sourceUtf8Bytes).toBeGreaterThan(articleRenderSourceByteLimit);
        expect(decision.byteMeasurement).toBe('lower-bound');
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('render-source-byte-limit');
    });
    it.each([-1, 0, 1])('measures the multibyte exact byte boundary at limit %+i', delta => {
        const source = '中'.repeat(Math.floor(articleRenderSourceByteLimit / 3)) + 'a'.repeat(2 + delta);
        const decision = evaluateArticleRenderRefreshPolicy(setup(source).context, source);
        expect(decision.sourceUtf8Bytes).toBe(articleRenderSourceByteLimit + delta);
        expect(decision.allowed).toBe(delta <= 0);
    });
    it.each([-1, 0, 1])('preserves the estimated-node boundary at limit %+i', delta => {
        const source = '\n'.repeat(articleRenderEstimatedNodeLimit + delta - 1);
        const decision = evaluateArticleRenderRefreshPolicy(setup(source).context, source);
        expect(decision.lineCount).toBe(articleRenderEstimatedNodeLimit + delta);
        expect(decision.estimatedNodeUnits).toBe(articleRenderEstimatedNodeLimit + delta);
        expect(decision.allowed).toBe(delta <= 0);
        expect(validateArticleRenderRefreshDecision(decision)).toBe(true);
    });
    it.each([
        ['# Heading', 3],
        ['- one\n- two', 6],
        ['- [ ] one\n- [x] two', 6],
        ['| h |\n| --- |\n| c |', 12],
        ['```ts\nx\n```', 63],
        ['```mermaid\ngraph TD; A-->B\n```', 63],
        ['```mermaid\ngraph TD; A-->B', 32],
        ['`code`', 1],
        ['\r\n\r\n', 3],
        ['', 0]
    ])('derives historical resource weights from public projection for %#', (source, units) => {
        const decision = evaluateArticleRenderRefreshPolicy(setup(source as string).context, source as string);
        expect(decision.estimatedNodeUnits).toBe(units);
        expect(decision.nodeMeasurement).toBe('exact');
        expect(decision.allowed).toBe(true);
        expect(Object.isFrozen(decision)).toBe(true);
        expect(createMarkdownEditorProjection(source as string).identity.version).toBe(decision.projectionVersion);
    });
    it.each(['heading', 'list'])('counts canonical %s cost at its own below/above boundary', kind => {
        for (const count of [1000, 1001])
        {
            const source = Array.from({ length: count }, () => kind === 'heading' ? '# H' : '- x').join('\n');
            const decision = evaluateArticleRenderRefreshPolicy(setup(source).context, source);
            if (count === 1000)
            {
                expect(decision.estimatedNodeUnits).toBe(articleRenderEstimatedNodeLimit);
                expect(decision.nodeMeasurement).toBe('exact');
            }
            else
            {
                expect(decision.estimatedNodeUnits).toBeGreaterThan(articleRenderEstimatedNodeLimit);
                expect(decision.nodeMeasurement).toBe('lower-bound');
            }
            expect(decision.allowed).toBe(count === 1000);
        }
    });
    it('rejects source mismatch and cannot authorize another article, revision or projection version', () => {
        const source = '# Same';
        const adapter = setup(source);
        expect(() => evaluateArticleRenderRefreshPolicy(adapter.context, '# Other')).toThrow('article-render-policy-source-invalid');
        const decision = evaluateArticleRenderRefreshPolicy(adapter.context, source);
        expect(admitArticleRenderRefreshDecision(decision, adapter.context, MARKDOWN_RENDERER_VERSION)).toBe(true);
        expect(admitArticleRenderRefreshDecision(decision, adapter.context, 'unavailable:v2')).toBe(false);
        adapter.updateSource(source + '\n');
        expect(admitArticleRenderRefreshDecision(decision, adapter.context, MARKDOWN_RENDERER_VERSION)).toBe(false);
        adapter.switchDocument({ articleId: 2, draftId: 'article:2', content: source });
        expect(admitArticleRenderRefreshDecision(decision, adapter.context, MARKDOWN_RENDERER_VERSION)).toBe(false);
    });
    it('does not invent a node count when the public projection fails', () => {
        vi.spyOn(markdown, 'createMarkdownEditorProjection').mockImplementationOnce(() => { throw new Error('unavailable'); });
        const source = '# Source';
        const decision = evaluateArticleRenderRefreshPolicy(setup(source).context, source);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('render-policy-projection-failed');
        expect(decision.estimatedNodeUnits).toBeNull();
        expect(decision.nodeMeasurement).toBe('not-run');
        expect(validateArticleRenderRefreshDecision(decision)).toBe(true);
    });
    it('skips the public projection when bytes or the line base already deny automatic refresh', () => {
        const projection = vi.spyOn(markdown, 'createMarkdownEditorProjection');
        for (const source of ['a'.repeat(articleRenderSourceByteLimit + 1), '\n'.repeat(articleRenderEstimatedNodeLimit)])
        {
            expect(evaluateArticleRenderRefreshPolicy(setup(source).context, source).allowed).toBe(false);
        }
        expect(projection).not.toHaveBeenCalled();
    });
    it('kills every decision field mutation and rejects re-digested copied authority', () => {
        const source = '# Source';
        const adapter = setup(source);
        const decision = evaluateArticleRenderRefreshPolicy(adapter.context, source);
        for (const key of Object.keys(decision))
        {
            expect(validateArticleRenderRefreshDecision({ ...decision, [key]: 'tampered' }), key).toBe(false);
        }
        expect(validateArticleRenderRefreshDecision({ ...decision, html: '<p>second body</p>' })).toBe(false);
        const { decisionDigest: _digest, ...unsigned } = decision;
        const clone = { ...unsigned, decisionDigest: digest(unsigned) };
        expect(validateArticleRenderRefreshDecision(clone)).toBe(true);
        expect(admitArticleRenderRefreshDecision(clone, adapter.context, MARKDOWN_RENDERER_VERSION)).toBe(false);
    });
    it('cache rejects caller-owned/forged decisions before starting any render task', async () => {
        const source = '# Source';
        const adapter = setup(source);
        const identity: ArticleRenderIdentity = { rendererVersion: MARKDOWN_RENDERER_VERSION,
            projectionVersion: MARKDOWN_RENDERER_VERSION, featureConfigurationDigest: digest({}),
            themeDigest: digest({}), locale: 'zh-CN' };
        const producer: ArticleRenderProducer = { render: vi.fn(), verify: vi.fn(), release: vi.fn() };
        const cache = new ArticleRenderCache(adapter, identity, producer, { maxEntryBytes: 65536, maxAgeMs: 1000, maxReceipts: 8 });
        const decision = evaluateArticleRenderRefreshPolicy(adapter.context, source);
        await expect(cache.autoRefresh({ ...decision })).rejects.toThrow('article-render-policy-invalid');
        await expect(cache.autoRefresh({ allowed: true, reason: null } as ArticleRenderRefreshDecision))
            .rejects.toThrow('article-render-policy-invalid');
        expect(producer.render).not.toHaveBeenCalled();
        expect(adapter.activeTaskRefs).toEqual([]);
        cache.dispose();
    });
    it('first above-limit source exposes the reason and requires an explicit manual refresh', async () => {
        const source = 'a'.repeat(articleRenderSourceByteLimit + 1);
        const adapter = setup(source);
        const producer: ArticleRenderProducer = { render: vi.fn(), verify: vi.fn(), release: vi.fn() };
        const cache = new ArticleRenderCache(adapter, { rendererVersion: MARKDOWN_RENDERER_VERSION,
            projectionVersion: MARKDOWN_RENDERER_VERSION, featureConfigurationDigest: digest({}),
            themeDigest: digest({}), locale: 'zh-CN' }, producer, { maxEntryBytes: 65536, maxAgeMs: 1000, maxReceipts: 8 });
        expect(await cache.autoRefresh(evaluateArticleRenderRefreshPolicy(adapter.context, source))).toBeNull();
        expect(cache.state.fallback).toBe('source');
        expect(cache.state.reason).toBe('render-source-byte-limit');
        expect(cache.state.actionIds).toContain('render-refresh');
        expect(producer.render).not.toHaveBeenCalled();
        adapter.switchDocument({ articleId: 2, draftId: 'article:2', content: '' });
        expect(cache.state.reason).toBe('no-valid-result');
        cache.dispose();
    });
});
