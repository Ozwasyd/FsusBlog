import { ElMarkdownRenderer } from '@ozwasyd/element-plus';
import { renderToString } from '@vue/server-renderer';
import { createSSRApp } from 'vue';
import { describe, expect, it } from 'vitest';

import type { ArticleDetailResponse } from '@/api/article';
import PublicArticleDetailPageContent from '@/components/public/pages/PublicArticleDetailPageContent.vue';
import { renderMarkdownResultWithRuntime } from '@/fsusui/markdown';
import { createPublicArticleDetailPageAssembly } from '@/public-renderers/pageAssemblies';
import { renderPublicAotPage } from '@/public-renderers/scaffold';
import { createArticleDetailPageViewContract } from '@/view-contracts/articleDetail';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { bindArticleDraftResponsibilitySnapshot, createArticleDraftResponsibilitySnapshot, type ArticleDraftResponsibilityDisclosure } from '@/view-contracts/articleDraftResponsibility';

import { articleRightsFixture } from '../fixtures/articleRights';

// Public-contract unit inputs only. These are not canonical DB/asset/publication receipts or draft acceptance.
const article = (id = 42): ArticleDetailResponse => ({
    id, title: `Article ${id} <Title>`, content: '# Public body\n\nBody text', summary: 'Public summary',
    coverImageUrl: '/unit-cover.png', views: 7, createTime: '2026-07-01T08:00:00.000Z',
    publishedAt: '2026-07-02T08:00:00.000Z', updatedAt: '2026-07-03T09:30:00.000Z',
    category: { id: 2, name: 'Engineering' }, tags: [{ id: 3, name: 'Contracts' }], rights: articleRightsFixture
});

const assemblyFor = async (input: ArticleDetailResponse, draftResponsibility?: ArticleDraftResponsibilityDisclosure) =>
{
    const result = await renderMarkdownResultWithRuntime({ source: input.content, mode: 'article' });
    if (!result.ok)
    {
        throw new Error('public-consumer-render-failed');
    }
    return createPublicArticleDetailPageAssembly({
        detailView: createArticleDetailPageViewContract(input, 0, false), articleId: input.id,
        authorName: 'Contract author', responsibilityAuthors: [{ name: 'Contract author', profileUrl: null }],
        responsibilityManifest: null, draftResponsibility, articleSummary: input.summary ?? '', canonicalUrl: null,
        hasBodyContent: true, bodyContent: input.content, initialRender: result.value
    });
};

const renderAssembly = async (input: ArticleDetailResponse) =>
{
    const assembly = await assemblyFor(input);
    const app = createSSRApp({ render: () => renderPublicAotPage(assembly) });
    app.component('ElMarkdownRenderer', ElMarkdownRenderer);
    return { assembly, html: await renderToString(app) };
};

describe('publication preview existing public consumer capability (#2283)', () => {
    it('executes the actual public reading composition with the canonical article renderer', async () => {
        const input = article();
        const { assembly, html } = await renderAssembly(input);
        expect(assembly.component).toBe(PublicArticleDetailPageContent);
        expect(html).toContain('data-fsus-reading-layout');
        expect(html).toContain('Article 42 &lt;Title&gt;');
        expect(html).toContain('/unit-cover.png');
        expect(html).toContain('Contract author');
        expect(html).toContain('2026-07-02T08:00:00.000Z');
        expect(html).toContain('2026-07-03T09:30:00.000Z');
        expect(html).toContain('Public body');
        expect(html).toContain('Body text');
        expect(html).toContain('data-article-tail-group');
        expect(html).toContain('data-article-rights-notice');
        expect(html).toContain('#contracts');
        expect(html).not.toContain('itemprop="mainEntityOfPage"');
    });
    it('does not equate a same-source public composition with another article or an editor-mode result', async () => {
        const first = await renderAssembly(article(41));
        const second = await renderAssembly(article(42));
        expect(first.assembly.props.bodyContent).toBe(second.assembly.props.bodyContent);
        expect(first.html).toContain('Article 41 &lt;Title&gt;');
        expect(second.html).toContain('Article 42 &lt;Title&gt;');
        expect(first.html).not.toBe(second.html);
        const editor = await renderMarkdownResultWithRuntime({ source: article().content, mode: 'editor' });
        expect(editor.ok).toBe(true);
        if (!editor.ok) throw new Error('editor-consumer-render-failed');
        expect((second.assembly.props.initialRender as { sourceIdentity: string; }).sourceIdentity)
            .not.toBe(editor.value.sourceIdentity);
    });
    it('uses the same actual public assembly for current draft responsibility without published verification', async () => {
        const input = article();
        const adapter = createArticleDocumentContextAdapter({ articleId: input.id, draftId: `article:${input.id}`,
            editorSessionId: 'session:preview', siteScope: 'site:preview', userScope: 'user:preview', content: input.content });
        const responsibility = {
            inheritSiteAuthor: true, authors: [], reviewer: null, sources: [], updateSummary: 'Current draft change',
            updateReason: 'Draft evidence', effectiveAt: null, conclusionImpact: 'clarified', responsiblePersonConfirmed: true
        };
        const snapshot = createArticleDraftResponsibilitySnapshot(adapter.context, responsibility, 'Draft site author');
        const assembly = await assemblyFor(input, bindArticleDraftResponsibilitySnapshot(adapter.context, responsibility, 'Draft site author', snapshot));
        const app = createSSRApp({ render: () => renderPublicAotPage(assembly) });
        app.component('ElMarkdownRenderer', ElMarkdownRenderer);
        const html = await renderToString(app);
        expect(assembly.component).toBe(PublicArticleDetailPageContent);
        expect(html).toContain('data-responsibility-authority="draft"');
        expect(html).toContain('Draft site author');
        expect(html).toContain('itemprop="author" content="Draft site author"');
        expect(html).not.toContain('Contract author');
        expect(html).toContain('Current draft change');
        expect(html).toContain('Public body');
        expect(html).not.toContain('data-article-verification-link');
        expect(html).not.toContain('/integrity/article/42/responsibility');
    });
});
