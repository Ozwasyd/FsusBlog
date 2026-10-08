import {
    cancelMarkdownEmbedRequest,
    commitMarkdownEmbedResult,
    createMarkdownEmbedProjectionRequest,
    prepareMarkdownEmbedResult,
    parseMarkdownEmbedLine,
    resolveMarkdownEmbedPresentation,
    type MarkdownEmbedRequest,
    type MarkdownEmbedResult
} from '@ozwasyd/element-plus/markdown-runtime';
import { describe, expect, it, vi } from 'vitest';

const article = 'article:01991e72-9a2c-7b60-8f47-b339f58e4a11';

const createRequest = () => createMarkdownEmbedProjectionRequest({
    documentIdentity: { id: 'document:denial-control', epoch: 3 }, revision: 8,
    nodeId: 'embed:denial', target: article, mode: 'article', version: 1
});

// Deliberately untrusted provider facts. No observation or source grant is supplied,
// and none of these controls may produce a prepared Markdown projection.
const untrustedResult = (request: MarkdownEmbedRequest): MarkdownEmbedResult => ({
    ...request,
    status: 'resolved',
    title: 'Untrusted target title',
    excerpt: 'Untrusted target excerpt',
    targetVersion: {
        targetIdentity: article,
        resolvedRevision: 'revision:8',
        targetVersionIdentity: 'version:8',
        projectionIdentity: 'projection:8',
        projectionDigest: 'a'.repeat(64)
    },
    projection: {
        kind: 'markdown-reference', projectionIdentity: 'projection:8', contentDigest: 'a'.repeat(64)
    }
});

const expectNoRenderedProjection = (request: MarkdownEmbedRequest, result: MarkdownEmbedResult) =>
{
    const node = parseMarkdownEmbedLine(`::embed[target="${article}" mode="article"]`);
    if (!node?.ok)
    {
        throw new Error('canonical directive did not parse');
    }
    const presentation = resolveMarkdownEmbedPresentation({ kind: 'valid', node, request, result }, 'preview');
    expect(presentation.content).toMatchObject({ markdown: null, html: null, title: null, excerpt: null });
};

const expectNoProjection = (request: MarkdownEmbedRequest, prepared: MarkdownEmbedResult) =>
{
    expect(prepared).toMatchObject({ ...request, status: 'stale' });
    expect(prepared).not.toHaveProperty('projection');
    expect(prepared).not.toHaveProperty('targetVersion');
    expect(prepared).not.toHaveProperty('title');
    expect(prepared).not.toHaveProperty('excerpt');
    expectNoRenderedProjection(request, prepared);
    expect(commitMarkdownEmbedResult(request, prepared)).toBe(prepared);
};

describe('actual FsusUI public projection authority denial', () =>
{
    it.each(['missing', 'throws'] as const)('denies %s version observation before any source read', async (state) =>
    {
        const request = await createRequest();
        const result = untrustedResult(request);
        const readTargetVersion = vi.fn(() =>
        {
            if (state === 'throws')
            {
                throw new Error('canonical source is unavailable');
            }
            return null;
        });
        const resolveMarkdown = vi.fn(() =>
        {
            throw new Error('source must not be read without current authorization');
        });
        try
        {
            const prepared = await prepareMarkdownEmbedResult(request, result, { readTargetVersion, resolveMarkdown });
            expectNoProjection(request, prepared);
            expect(readTargetVersion).toHaveBeenCalledOnce();
            expect(resolveMarkdown).not.toHaveBeenCalled();
            expectNoRenderedProjection(request, result);
        }
        finally
        {
            cancelMarkdownEmbedRequest(request);
        }
    });

    it.each(['document', 'epoch', 'revision', 'aborted'] as const)(
        'denies %s host drift before consulting target authority', async (field) =>
        {
            const request = await createRequest();
            const result = untrustedResult(request);
            const changed = field === 'document'
                ? { ...result, documentIdentity: { id: 'document:other', epoch: 3 } }
                : field === 'epoch'
                    ? { ...result, documentIdentity: { id: request.documentIdentity.id, epoch: 4 } }
                    : field === 'revision'
                        ? { ...result, revision: request.revision + 1 }
                        : result;
            const readTargetVersion = vi.fn(() => null);
            const resolveMarkdown = vi.fn(() =>
            {
                throw new Error('source must not be read after host drift');
            });
            try
            {
                if (field === 'aborted')
                {
                    cancelMarkdownEmbedRequest(request);
                }
                const prepared = await prepareMarkdownEmbedResult(request, changed, { readTargetVersion, resolveMarkdown });
                expect(prepared).toMatchObject({ ...request, status: 'stale' });
                expectNoRenderedProjection(request, prepared);
                expect(prepared).not.toHaveProperty('projection');
                expect(readTargetVersion).not.toHaveBeenCalled();
                expect(resolveMarkdown).not.toHaveBeenCalled();
                expectNoRenderedProjection(request, changed);
            }
            finally
            {
                cancelMarkdownEmbedRequest(request);
            }
        }
    );
});
