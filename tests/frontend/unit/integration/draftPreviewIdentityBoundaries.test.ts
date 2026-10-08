import {
    MARKDOWN_RENDERER_VERSION,
    createMarkdownAnchorMap,
    stabilizeMarkdownEditorProjection
} from '@ozwasyd/element-plus/markdown-runtime';
import { describe, expect, it } from 'vitest';

import { ArticleAnchorContextAdapter } from '@/services/authoring/articleAnchorContext';
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';
import { ArticleFsusUiRenderProducer } from '@/services/authoring/articleFsusUiRenderProducer';
import { ArticleRenderCache, validateArticleRenderReceipt } from '@/services/authoring/articleRenderCache';
import { articleRenderSourceByteLimit, evaluateArticleRenderRefreshPolicy } from '@/services/authoring/articleRenderRefreshPolicy';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';

const configuration = { allowLatex: true, allowMermaid: true, baseUrl: null };
const initialSource = '# Private draft\n\nIdentical body across documents.';

function openDraft()
{
    let source = initialSource;
    const owner = createArticleDocumentContextAdapter({
        articleId: 41, draftId: 'draft:41', editorSessionId: 'session:integration',
        siteScope: 'site:integration', userScope: 'user:integration', content: source
    });
    const producer = new ArticleFsusUiRenderProducer(() => source, configuration, 2_000_000);
    const cache = new ArticleRenderCache(owner, {
        rendererVersion: MARKDOWN_RENDERER_VERSION,
        projectionVersion: MARKDOWN_RENDERER_VERSION,
        featureConfigurationDigest: digest(configuration),
        themeDigest: digest({ theme: 'light' }), locale: 'zh-CN'
    }, producer, { maxEntryBytes: 65_536, maxAgeMs: 60_000, maxReceipts: 8 });
    const anchors = new ArticleAnchorContextAdapter(owner);
    const binding = () => ({ document: owner.context, map: createMarkdownAnchorMap({ identity: owner.documentIdentity, source }) });
    return {
        owner, producer, cache, anchors, binding,
        update: (next: string) => { source = next; owner.updateSource(next); },
        dispose: () => { cache.dispose(); owner.dispose(); }
    };
}

describe('draft preview identity across real renderer, cache and anchor owners', () =>
{
    it('resolves retained public syntax identities using the actual Blog opaque document identity', async () =>
    {
        const draft = openDraft();
        try
        {
            expect((await draft.cache.refresh()).status).toBe('committed');
            const retained = draft.producer.resolve(draft.cache.state.content!.result)!;
            const stable = stabilizeMarkdownEditorProjection(retained.projection, draft.owner.documentIdentity);
            expect(stable.nodes.length).toBeGreaterThan(0);
            for (const node of stable.nodes)
            {
                expect(stable.resolve(node.id), `public node ${node.id} for ${draft.owner.context.documentId}`)
                    .toMatchObject({ status: 'current', node });
            }
        }
        finally
        {
            draft.dispose();
        }
    });

    it('rejects identical-body foreign document cache and anchor references in the same turn', async () =>
    {
        const draft = openDraft();
        try
        {
            expect((await draft.cache.refresh()).status).toBe('committed');
            const old = draft.cache.state.content!;
            const saved = draft.anchors.capture(draft.binding(), { start: 0, end: 15, direction: 'backward' }, {
                affinity: 'before', viewportOffset: 20, percentage: 0.3, surface: 'live', tool: 'publish-preview'
            });
            draft.owner.switchDocument({ articleId: 42, draftId: 'draft:42', content: initialSource });
            expect(draft.owner.context.contentDigest).toBe(old.context.contentDigest);
            expect(draft.cache.state.content).toBeNull();
            expect(draft.producer.resolve(old.result)).toBeNull();
            expect(draft.anchors.restore(saved, draft.binding(), {
                origin: 'tool', now: 1, viewportHeight: 600, reducedMotion: true
            })).toMatchObject({ status: 'rejected', reason: 'document-mismatch', nodeId: null, range: null });
            expect((await draft.cache.refresh()).status).toBe('committed');
            expect(draft.cache.state.content!.context.articleId).toBe(42);
            expect(draft.cache.state.content!.result.contextDigest).not.toBe(old.result.contextDigest);
        }
        finally
        {
            draft.dispose();
        }
    });

    it('keeps same-document last-valid source while anchors reject unmapped current revision', async () =>
    {
        const draft = openDraft();
        try
        {
            await draft.cache.refresh();
            const old = draft.cache.state.content!;
            const saved = draft.anchors.capture(draft.binding(), { start: 0, end: 5, direction: 'forward' }, {
                affinity: 'after', viewportOffset: 20, percentage: 0.3, surface: 'live', tool: 'source-compare'
            });
            const next = '# Current private revision\n' + 'x'.repeat(articleRenderSourceByteLimit);
            draft.update(next);
            expect(await draft.cache.autoRefresh(evaluateArticleRenderRefreshPolicy(draft.owner.context, next))).toBeNull();
            expect(draft.cache.state.stale).toBe(true);
            expect(draft.producer.resolve(draft.cache.state.content!.result)!.render.rawSource).toBe(initialSource);
            expect(draft.cache.state.content).toBe(old);
            expect(draft.anchors.restore(saved, draft.binding(), {
                origin: 'refresh', now: 1, viewportHeight: 600, reducedMotion: true
            })).toMatchObject({ status: 'rejected', reason: 'source-revision-unmapped' });
        }
        finally
        {
            draft.dispose();
        }
    });

    it('settles cancellation before a real public renderer can commit and permits a current retry', async () =>
    {
        const draft = openDraft();
        try
        {
            await draft.cache.refresh();
            const old = draft.cache.state.content;
            const pending = draft.cache.refresh();
            draft.cache.cancel();
            const receipt = await pending;
            expect(receipt.status).toBe('canceled');
            expect(validateArticleRenderReceipt(receipt)).toBe(true);
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(draft.cache.state.content).toBe(old);
            expect(draft.owner.activeTaskRefs).toEqual([]);
            expect((await draft.cache.refresh()).status).toBe('committed');
        }
        finally
        {
            draft.dispose();
        }
    });

    it('rejects a real in-flight result after same-body epoch switch before the new render', async () =>
    {
        const draft = openDraft();
        try
        {
            const pending = draft.cache.refresh();
            draft.owner.switchDocument({ articleId: 42, draftId: 'draft:42', content: initialSource });
            expect(draft.cache.state.content).toBeNull();
            expect((await pending).status).toBe('canceled');
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(draft.cache.state.content).toBeNull();
            expect((await draft.cache.refresh()).status).toBe('committed');
            expect(draft.cache.state.content!.context.articleId).toBe(42);
            expect(draft.producer.resolve(draft.cache.state.content!.result)!.render.rawSource).toBe(initialSource);
        }
        finally
        {
            draft.dispose();
        }
    });
});
