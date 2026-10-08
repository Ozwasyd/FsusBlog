import { describe, expect, it } from 'vitest';

import * as fsusUi from '@ozwasyd/element-plus';
import {
    MARKDOWN_ANCHOR_ID,
    collectMarkdownAnchorNodes,
    createMarkdownEditorProjection,
    stabilizeMarkdownEditorProjection
} from '@ozwasyd/element-plus/markdown-runtime';

import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext';

describe('Required actual public block-anchor boundary (#2444)', () =>
{
    it.each(['currentMarkdownAnchors', 'planMarkdownAnchorInsert', 'planMarkdownAnchorEdit', 'planMarkdownAnchorRemove'])(
        'exports existing %s through the documented public package entry', name =>
        {
            expect(Reflect.get(fsusUi, name)).toBeTypeOf('function');
        }
    );

    it('resolves the actual opaque identity emitted by the Blog document owner', () =>
    {
        const owner = createArticleDocumentContextAdapter({
            articleId: 1, draftId: 'article:1', editorSessionId: 'editor:test',
            userScope: 'user:test', siteScope: 'site:test', content: 'Paragraph ^intro'
        });
        const projection = stabilizeMarkdownEditorProjection(
            createMarkdownEditorProjection('Paragraph ^intro'), owner.documentIdentity
        );
        const node = projection.nodes.find(item => item.kind === 'anchor');
        expect(node).toBeDefined();
        expect(projection.resolve(node!.id).status).toBe('current');
    });

    it.each(['intro\n', 'intro\r\n'])('the public ID validator denies trailing bytes in %j', candidate =>
    {
        expect(MARKDOWN_ANCHOR_ID.test(candidate)).toBe(false);
    });

    it.each(['bad_name', '章节', 'a'.repeat(65)])('reports invalid marker %j without losing the diagnostic', candidate =>
    {
        const nodes = collectMarkdownAnchorNodes(`Paragraph ^${candidate}`);
        expect(nodes.some(node => !node.ok && node.code === 'anchor-invalid-id')).toBe(true);
    });

    it('retains duplicate diagnostics and exact standard fragments', () =>
    {
        const nodes = collectMarkdownAnchorNodes('First ^intro\n\nSecond ^intro');
        expect(nodes).toHaveLength(2);
        expect(nodes[0]).toMatchObject({ ok: true, id: 'intro', fragment: '#intro' });
        expect(nodes[1]).toMatchObject({ ok: false, code: 'anchor-duplicate' });
    });
});
