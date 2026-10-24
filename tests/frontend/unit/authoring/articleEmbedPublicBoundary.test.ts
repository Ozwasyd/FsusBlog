import {
    collectMarkdownEmbedNodes,
    commitMarkdownEmbedResult,
    createMarkdownEmbedRequest,
    parseMarkdownEmbedLine,
    planMarkdownEmbedInsert
} from '@ozwasyd/element-plus/markdown-runtime';
import { describe, expect, it } from 'vitest';

const article = 'article:01991e72-9a2c-7b60-8f47-b339f58e4a11';
const heading = 'heading:01991e72-b871-7a86-bc95-5518cf8bd7dc';

// These probes consume the documented public entry point through Blog's real
// local alias; they do not add a Blog grammar, target codec or provider authority.
describe('article embed public source boundary (#2458, source stage)', () =>
{
    it.each([
        [article, 'article'],
        [`${article}#${heading}`, 'heading'],
        [`${article}#release-notes-2026`, 'block']
    ] as const)('preserves the explicit %s / %s directive and its UTF-16 source range', (target, mode) =>
    {
        const prefix = 'Host 😀\r\n';
        const plan = planMarkdownEmbedInsert(prefix, { start: prefix.length, end: prefix.length }, target, mode);
        const source = prefix.slice(0, plan.from) + plan.insert + prefix.slice(plan.to);
        const nodes = collectMarkdownEmbedNodes(source);
        expect(nodes).toHaveLength(1);
        const node = nodes[0]!;
        expect(node.ok).toBe(true);
        if (!node.ok) throw new Error(node.code);
        expect(node.target).toBe(target);
        expect(node.mode).toBe(mode);
        expect(source.slice(node.ranges.full.start, node.ranges.full.end)).toBe(`::embed[target="${target}" mode="${mode}"]`);
        expect(node.ranges.full.start).toBe(prefix.length);
        expect(source.slice(node.ranges.target.start, node.ranges.target.end)).toBe(target);
        expect(source.slice(node.ranges.mode.start, node.ranges.mode.end)).toBe(mode);
    });

    it.each([
        [`::embed[target="${article}"]`, 'embed-missing-mode'],
        [`::embed[target="${article}" mode="Article"]`, 'embed-inferred-mode'],
        [`::embed[target="${article}" mode="card"]`, 'embed-invalid-mode'],
        [`::embed[mode="article" target="${article}"]`, 'embed-attribute-order'],
        [` ::embed[target="${article}" mode="article"]`, 'embed-indent'],
        [`::embed[target="${article}" mode="article"] trailing`, 'embed-trailing-content'],
        [`::embed[target="${article}" mode="article" latest="true"]`, 'embed-unknown-attribute'],
        ['::embed[target="bad\\q" mode="article"]', 'embed-unknown-escape']
    ])('rejects invalid grammar through the upstream parser: %s', (source, code) =>
    {
        expect(parseMarkdownEmbedLine(source)).toMatchObject({ ok: false, code });
    });

    it.each([
        '::include[target="legacy"]',
        '[[legacy]]',
        '<iframe src="https://example.test"></iframe>',
        '<div include="legacy"></div>',
        'prefix ::embed[target="legacy" mode="article"]'
    ])('does not admit a legacy source as an embed directive: %s', (source) =>
    {
        expect(parseMarkdownEmbedLine(source)).toBeNull();
    });

    it.each(['requestId', 'document', 'epoch', 'revision', 'nodeId', 'target', 'mode', 'version'] as const)(
        'rejects provider completion after %s identity drift', (field) =>
        {
            const request = createMarkdownEmbedRequest({
                documentIdentity: { id: 'document:host', epoch: 3 }, revision: 8,
                nodeId: 'embed:one', target: article, mode: 'article', version: 1
            });
            const result = { ...request, status: 'resolved' as const, title: 'Source' };
            const changed = field === 'document'
                ? { ...result, documentIdentity: { id: 'document:other', epoch: 3 } }
                : field === 'epoch'
                    ? { ...result, documentIdentity: { id: 'document:host', epoch: 4 } }
                    : { ...result, ...{
                        requestId: { requestId: 'request:other' }, revision: { revision: 9 },
                        nodeId: { nodeId: 'embed:other' }, target: { target: `${article}#${heading}` },
                        mode: { mode: 'heading' as const }, version: { version: 2 }
                    }[field] };
            expect(commitMarkdownEmbedResult(request, changed)).toMatchObject({ ...request, status: 'stale' });
        }
    );

    it('retains the exact current result without mutating host bytes', () =>
    {
        const source = `::embed[target="${article}" mode="article"]`;
        const request = createMarkdownEmbedRequest({
            documentIdentity: { id: 'document:host', epoch: 3 }, revision: 8,
            nodeId: 'embed:one', target: article, mode: 'article', version: 1
        });
        const result = { ...request, status: 'resolved' as const, title: 'Source', excerpt: 'Inert display facts' };
        expect(commitMarkdownEmbedResult(request, result)).toBe(result);
        expect(source).toBe(`::embed[target="${article}" mode="article"]`);
    });
});
