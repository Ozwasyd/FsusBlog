import { ElMarkdownRenderer } from '@ozwasyd/element-plus';
import { renderToString } from '@vue/server-renderer';
import { createSSRApp } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArticleDetailResponse } from '@/api/article';
import { provideFsusUiAppContext } from '@/fsusui/appContext';
import { MARKDOWN_RENDERER_VERSION, renderMarkdownResultWithRuntime } from '@/fsusui/markdown';
import { decodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload';
import { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog';
import { createPublicArticleDetailPageAssembly } from '@/public-renderers/pageAssemblies';
import { renderPublicArticleDetailEntry } from '@/public-renderers/publicEntryRegistry';
import { renderPublicHydrationSnapshot } from '@/public-renderers/renderPublicPage';
import { renderPublicAotPage } from '@/public-renderers/scaffold';
import type { PublicArticleDetailHydrationPayload } from '@/public-renderers/types';
import { ArticleDocumentContextAuthority } from '@/services/authoring/articleDocumentContext';
import { ArticleFsusUiRenderProducer } from '@/services/authoring/articleFsusUiRenderProducer';
import { ArticlePreviewSourceAdmission } from '@/services/authoring/articlePreviewSourceAdmission';
import { ArticleRenderCache, type ArticleRenderIdentity } from '@/services/authoring/articleRenderCache';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';
import { createArticleDetailPageViewContract } from '@/view-contracts/articleDetail';
import {
    bindArticleDraftResponsibilitySnapshot,
    admitArticleDraftResponsibilitySnapshot,
    type ArticleDraftResponsibilityDisclosure,
    type ArticleDraftResponsibilitySource
} from '@/view-contracts/articleDraftResponsibility';

import { articleRightsFixture } from '../fixtures/articleRights';

// Source-integration inputs only: no DB, publication, signed manifest, permission or activation receipts.
// The renderer, projection producer, cache, responsibility admission and SSR composition are real.
const configuration = { allowLatex: true, allowMermaid: true, baseUrl: null };
const identity: ArticleRenderIdentity = {
    rendererVersion: MARKDOWN_RENDERER_VERSION,
    projectionVersion: MARKDOWN_RENDERER_VERSION,
    featureConfigurationDigest: digest(configuration),
    themeDigest: digest({ theme: 'light' }),
    locale: 'zh-CN'
};
const draftAuthor = 'DRAFT-AUTHOR-ONLY-2245';
const privateEvidence = 'PRIVATE-EVIDENCE-ONLY-2245';
const privateBody = 'PRIVATE-DRAFT-BODY-ONLY-2245';
const publicAuthor = 'Published input author';
const responsibility: ArticleDraftResponsibilitySource = {
    inheritSiteAuthor: false,
    authors: [{ name: draftAuthor, profileUrl: null }],
    reviewer: null,
    sources: [{ title: privateEvidence, url: 'https://evidence.example/private', sourceType: 'other',
        accessedOn: null, version: null, citationNote: privateEvidence, isPublic: false }],
    updateSummary: 'DRAFT-UPDATE-ONLY-2245', updateReason: 'Draft editing', effectiveAt: null,
    conclusionImpact: 'clarified', responsiblePersonConfirmed: true
};

const article = (id: number, content: string): ArticleDetailResponse => ({
    id, title: `Article ${id}`, content, summary: 'Published input summary', coverImageUrl: null,
    views: 1, createTime: '2026-07-01T08:00:00.000Z', publishedAt: '2026-07-02T08:00:00.000Z',
    category: { id: 2, name: 'Engineering' }, tags: [], rights: articleRightsFixture
});

const draftFor = (id: number, source: string) =>
{
    let currentResponsibility = responsibility;
    const authority = new ArticleDocumentContextAuthority();
    const host = authority.acquire({ articleId: id, siteScope: 'site:ssr-boundaries',
        userScope: 'user:ssr-boundaries', content: source });
    const adapter = host.adapter;
    const sourceAdmission = ArticlePreviewSourceAdmission.attach(() => ({ context: adapter.context,
        source, responsibility: currentResponsibility, siteAuthor: 'Site author', attachmentLifecycleHistory: [] }), authority);
    const sourceRequest = sourceAdmission.begin();
    const producer = new ArticleFsusUiRenderProducer(() => source, configuration, 262144);
    const cache = new ArticleRenderCache(adapter, identity, producer,
        { maxEntryBytes: 65536, maxAgeMs: 60000, maxReceipts: 8 });
    const snapshot = sourceRequest.responsibility;
    const disclosure = bindArticleDraftResponsibilitySnapshot(adapter.context, responsibility, 'Site author', snapshot);
    return { adapter, producer, cache, snapshot, disclosure, sourceAdmission, sourceRequest,
        setResponsibility: (value: ArticleDraftResponsibilitySource) => { currentResponsibility = value; },
        dispose: () => { sourceAdmission.dispose(); cache.dispose(); host.release(); adapter.dispose(); } };
};

const ssrArticle = async (input: ArticleDetailResponse, draftResponsibility?: ArticleDraftResponsibilityDisclosure) =>
{
    const rendered = await renderMarkdownResultWithRuntime({ source: input.content, mode: 'article', ...configuration });
    if (!rendered.ok) throw new Error(`actual-public-render-failed:${JSON.stringify(rendered.error)}`);
    const assembly = createPublicArticleDetailPageAssembly({
        detailView: createArticleDetailPageViewContract(input, 0, false), articleId: input.id,
        authorName: publicAuthor, responsibilityAuthors: [{ name: publicAuthor, profileUrl: null }],
        responsibilityManifest: null, draftResponsibility, articleSummary: input.summary ?? '',
        canonicalUrl: `https://public.example/article/${input.id}`, hasBodyContent: true,
        bodyContent: input.content, initialRender: rendered.value
    });
    const app = createSSRApp({ render: () => renderPublicAotPage(assembly) });
    provideFsusUiAppContext(app);
    app.component('ElMarkdownRenderer', ElMarkdownRenderer);
    return { assembly, rendered: rendered.value, html: await renderToString(app) };
};

describe('draft preview to actual public SSR boundaries (local FsusUI source integration)', () =>
{
    beforeEach(() =>
    {
        // The common unit setup supplies a real happy-dom document; its events must use the same realm.
        // These are DOM constructors, not renderer, theme, disclosure or publication mocks.
        vi.stubGlobal('Event', window.Event);
        vi.stubGlobal('CustomEvent', window.CustomEvent);
    });

    afterEach(() => vi.unstubAllGlobals());

    it('rejects article A draft attribution when the real SSR destination is same-body article B', async () =>
    {
        const source = '# Identical body\n\nSame bytes do not authorize another article.';
        const draft = draftFor(41, source);
        try
        {
            expect((await draft.cache.refresh()).status).toBe('committed');
            expect(draft.producer.resolve(draft.cache.state.content!.result)?.render.rawSource).toBe(source);
            expect(draft.sourceAdmission.accept(draft.sourceRequest, draft.cache.state.content!.result).accepted).toBe(true);
            const destination = await ssrArticle(article(42, source), draft.disclosure);
            expect(destination.html).toContain('Article 42');
            expect(destination.html, 'A genuine disclosure must still bind to the destination article, not only itself')
                .not.toContain(draftAuthor);
            expect(destination.html).not.toContain('DRAFT-UPDATE-ONLY-2245');
            expect(destination.html).not.toContain(privateEvidence);
        }
        finally
        {
            draft.dispose();
        }
    });

    it('filters private evidence from a real draft projection and SSR without creating published verification', async () =>
    {
        const draft = draftFor(41, `# ${privateBody}`);
        try
        {
            expect((await draft.cache.refresh()).status).toBe('committed');
            const retained = draft.producer.resolve(draft.cache.state.content!.result)!;
            const preview = await ssrArticle(article(41, retained.render.rawSource), draft.disclosure);
            expect(preview.html).toContain(privateBody);
            expect(preview.html).toContain(draftAuthor);
            expect(preview.html).toContain('data-responsibility-authority="draft"');
            expect(preview.html).toContain('data-proof-status="not-published"');
            expect(preview.html).not.toContain(privateEvidence);
            expect(preview.html).not.toContain('https://evidence.example/private');
            expect(preview.html).not.toContain('data-article-sources');
            expect(preview.html).not.toContain('data-article-verification-link');
            expect(preview.html).not.toContain('/integrity/article/41/responsibility');
            expect(draft.snapshot.sources).toEqual([]);
            expect(preview.assembly.props.responsibilityManifest).toBeNull();
            expect(preview.rendered.sourceIdentity).not.toBe(retained.render.sourceIdentity);
            expect(preview.rendered.rawSource).toBe(retained.render.rawSource);
        }
        finally
        {
            draft.dispose();
        }
    });

    it('keeps live private renderer state and draft responsibility out of actual public entry seeds and hydrated SSR', async () =>
    {
        const draft = draftFor(41, `# ${privateBody}`);
        try
        {
            expect((await draft.cache.refresh()).status).toBe('committed');
            const result = draft.cache.state.content!.result;
            const publishedBody = '# PUBLIC-BODY-2245\n\nPublished input only.';
            const publicEntry = await renderPublicArticleDetailEntry({
                ...article(42, publishedBody), bodyContent: publishedBody, authorName: publicAuthor,
                siteTitle: 'Public integration fixture', siteDescription: '', baseUrl: 'https://public.example',
                renderTimestamp: '2026-07-04T08:00:00.000Z', renderLocale: 'zh-CN',
                renderDisplayTimeZone: 'UTC', localeCatalogDigest: LOCALE_CATALOG_DIGEST,
                // Real draft outputs at the broad build-options boundary must not be interpreted as publication.
                draftResponsibility: draft.disclosure, responsibility: draft.snapshot,
                previewSource: privateBody, previewResult: draft.producer.resolve(result), renderCache: draft.cache.state
            });
            const bootstrap = decodePublicAotPayload(publicEntry.entry.bootstrapPayload);
            const hydration = decodePublicAotPayload<PublicArticleDetailHydrationPayload>(publicEntry.entry.hydrationPropsPayload);
            expect(bootstrap).not.toBeNull();
            expect(hydration).not.toBeNull();
            expect(hydration!.bodyContent).toBe(publishedBody);
            expect(hydration!.articleId).toBe(42);
            expect(hydration!.responsibilityManifest).toBeNull();
            expect(hydration).not.toHaveProperty('draftResponsibility');
            expect(hydration).not.toHaveProperty('previewResult');
            const hydratedHtml = await renderPublicHydrationSnapshot(hydration!);
            for (const output of [publicEntry.entry.html, JSON.stringify(bootstrap), JSON.stringify(hydration), hydratedHtml])
            {
                expect(output).toContain('PUBLIC-BODY-2245');
                expect(output).not.toContain(privateBody);
                expect(output).not.toContain(privateEvidence);
                expect(output).not.toContain(draftAuthor);
                expect(output).not.toContain('DRAFT-UPDATE-ONLY-2245');
                expect(output).not.toContain(result.resultRef!);
            }
            for (const html of [publicEntry.entry.html, hydratedHtml])
            {
                expect(html).toContain(`itemprop="author" content="${publicAuthor}"`);
                expect(html).toContain('data-responsibility-authority="published"');
                expect(html).not.toContain('data-responsibility-authority="draft"');
            }
            // Publication did not consume or clear the separate live private cache.
            expect(draft.producer.resolve(result)?.render.rawSource).toContain(privateBody);
        }
        finally
        {
            draft.dispose();
        }
    });

    it('rejects a retained draft disclosure after its real document owner is disposed', async () =>
    {
        const source = '# Retained disclosure';
        const draft = draftFor(41, source);
        try
        {
            expect((await draft.cache.refresh()).status).toBe('committed');
            const renderedResult = draft.cache.state.content!.result;
            expect(admitArticleDraftResponsibilitySnapshot(draft.disclosure)).toBe(true);
            draft.adapter.dispose();
            expect(draft.producer.resolve(renderedResult)).toBeNull();
            expect(draft.sourceRequest.signal.aborted).toBe(true);
            expect(draft.sourceAdmission.accept(draft.sourceRequest, renderedResult).accepted).toBe(false);
            // This tests actual owner teardown only, not server permission revocation: no such admission API exists here.
            const afterRelease = await ssrArticle(article(41, source), draft.disclosure);
            expect(afterRelease.html, 'A retained projection must not remain usable after the real owning context ends')
                .not.toContain(draftAuthor);
            expect(afterRelease.html).not.toContain('DRAFT-UPDATE-ONLY-2245');
        }
        finally
        {
            draft.dispose();
        }
    });

    it('invalidates stale responsibility metadata independently of an unchanged actual renderer result', async () =>
    {
        const source = '# Unchanged Markdown';
        const draft = draftFor(41, source);
        try
        {
            expect((await draft.cache.refresh()).status).toBe('committed');
            const renderedResult = draft.cache.state.content!.result;
            const changedResponsibility = { ...responsibility, authors: [{ name: 'New draft author', profileUrl: null }] };
            draft.setResponsibility(changedResponsibility);
            expect(draft.sourceAdmission.accept(draft.sourceRequest, renderedResult).accepted).toBe(false);
            const staleDisclosure = bindArticleDraftResponsibilitySnapshot(draft.adapter.context,
                changedResponsibility, 'Site author', draft.snapshot);
            expect(admitArticleDraftResponsibilitySnapshot(staleDisclosure)).toBe(false);
            const preview = await ssrArticle(article(41, source), staleDisclosure);
            expect(preview.html).toContain('Unchanged Markdown');
            expect(preview.html).toContain('data-manifest-state="invalid"');
            expect(preview.html).not.toContain(draftAuthor);
            expect(preview.html).not.toContain('New draft author');
            expect(preview.html).not.toContain('DRAFT-UPDATE-ONLY-2245');
            expect(preview.html).not.toContain('data-article-verification-link');
            expect(draft.cache.state.content!.result).toEqual(renderedResult);
            expect(draft.producer.resolve(renderedResult)?.render.rawSource).toBe(source);
        }
        finally
        {
            draft.dispose();
        }
    });
});
