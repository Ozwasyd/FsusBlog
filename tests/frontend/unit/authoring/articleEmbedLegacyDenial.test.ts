import {
    collectMarkdownEmbedNodes,
    commitMarkdownEmbedResult,
    createMarkdownEmbedRequest,
    parseMarkdownEmbedLine
} from '@ozwasyd/element-plus/markdown-runtime';
import { describe, expect, it } from 'vitest';

const article = 'article:01991e72-9a2c-7b60-8f47-b339f58e4a11';

describe('actual FsusUI public legacy embed denial', () =>
{
    it.each([
        '::include[target="legacy"]',
        '::include[target="https://example.test/private"]',
        '::include[target="file:///private/document.md"]',
        '[[legacy]]',
        '![[legacy]]',
        '<iframe src="https://example.test"></iframe>',
        '<include src="/private/document.md"></include>'
    ])('does not classify legacy source as an embed: %s', (source) =>
    {
        expect(parseMarkdownEmbedLine(source)).toBeNull();
        expect(collectMarkdownEmbedNodes(source)).toEqual([]);
    });

    it.each(['latest="true"', 'private-copy="true"', 'refresh="auto"', 'src="https://example.test"'])(
        'rejects the legacy attribute %s through the sole parser', (attribute) =>
        {
            expect(parseMarkdownEmbedLine(`::embed[target="${article}" mode="article" ${attribute}]`)).toMatchObject({
                ok: false, code: 'embed-unknown-attribute'
            });
        }
    );

    it.each(['html', 'iframe', 'component', 'privateCopy'])(
        'refuses an untyped provider field %s', (field) =>
        {
            const request = createMarkdownEmbedRequest({
                documentIdentity: { id: 'document:legacy-control', epoch: 3 }, revision: 8,
                nodeId: 'embed:one', target: article, mode: 'article', version: 1
            });
            expect(commitMarkdownEmbedResult(request, {
                ...request, status: 'resolved', [field]: '<iframe>unsafe</iframe>'
            })).toMatchObject({ status: 'rejected', reason: 'invalid-result' });
        }
    );
});
