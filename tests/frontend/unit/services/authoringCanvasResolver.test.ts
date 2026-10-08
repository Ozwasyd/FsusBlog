import { InMemoryTargetArticleProvider } from '../../fixtures/authoringCanvasTransportFixture';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
    AuthoringCanvasArticleReferenceNode,
    AuthoringCanvasBlockReferenceNode,
    AuthoringCanvasHeadingReferenceNode
} from '@/contracts/authoringCanvas';
import {
    AuthoringCanvasResolver,
    type ResolutionContext
} from '@/services/authoringCanvasResolver';

describe('Authoring Canvas Reference Resolver (#2483)', () => {
    let provider: InMemoryTargetArticleProvider;
    let resolver: AuthoringCanvasResolver;

    const testContext: ResolutionContext = {
        userId: 'user-alice',
        siteId: 'site-default',
        canvasId: 'canvas-test-1',
        canvasRevision: 1
    };

    beforeEach(() => {
        provider = new InMemoryTargetArticleProvider();
        resolver = new AuthoringCanvasResolver(provider);

        provider.setArticle({
            id: 101,
            title: 'Distributed Consensus Foundations',
            revision: 5,
            snippet: 'A deep dive into Paxos, Raft, and PBFT protocols with formal verification.',
            allowedUserIds: ['user-alice', 'user-bob'],
            headings: [
                { id: 'heading-raft', text: 'Raft Log Replication' },
                { id: 'heading-pbft', text: 'PBFT View Change' }
            ],
            blocks: [
                { id: 'blk-quorum', previewText: 'Quorum intersection invariant must hold.' }
            ]
        });

        provider.setArticle({
            id: 102,
            title: 'Confidential Internal Review',
            revision: 1,
            snippet: 'Strictly private financial roadmap.',
            allowedUserIds: ['user-secret-agent']
        });

        provider.setArticle({
            id: 103,
            title: 'Archived Deprecated Whitepaper',
            revision: 2,
            isArchived: true,
            allowedUserIds: ['user-alice']
        });
    });

    it('resolves an unpinned current article reference', async () => {
        const node: AuthoringCanvasArticleReferenceNode = {
            id: 'node-art-1',
            type: 'article-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 101
        };

        const projection = await resolver.resolveNodeReference(node, testContext);
        expect(projection).not.toBeNull();
        expect(projection?.status).toBe('current');
        expect(projection?.title).toBe('Distributed Consensus Foundations');
        expect(projection?.snippet).toContain('A deep dive into Paxos');
        expect(projection?.targetRevision).toBe(5);
        expect(projection?.openIntent?.route).toBe('/admin/article/edit/101');
    });

    it('resolves pinned-current when pinned revision matches article revision', async () => {
        const node: AuthoringCanvasArticleReferenceNode = {
            id: 'node-art-2',
            type: 'article-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 101,
            pinnedTargetRevision: 5
        };

        const projection = await resolver.resolveNodeReference(node, testContext);
        expect(projection?.status).toBe('pinned-current');
    });

    it('resolves pinned-stale when pinned revision is older than current article revision', async () => {
        const node: AuthoringCanvasArticleReferenceNode = {
            id: 'node-art-3',
            type: 'article-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 101,
            pinnedTargetRevision: 2
        };

        const projection = await resolver.resolveNodeReference(node, testContext);
        expect(projection?.status).toBe('pinned-stale');
        expect(projection?.targetRevision).toBe(5);
    });

    it('resolves heading and block references with navigation coordinate intents', async () => {
        const headingNode: AuthoringCanvasHeadingReferenceNode = {
            id: 'node-heading-1',
            type: 'heading-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 101,
            targetHeadingId: 'heading-raft'
        };

        const blockNode: AuthoringCanvasBlockReferenceNode = {
            id: 'node-block-1',
            type: 'block-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 101,
            targetBlockId: 'blk-quorum'
        };

        const headingProj = await resolver.resolveNodeReference(headingNode, testContext);
        expect(headingProj?.status).toBe('current');
        expect(headingProj?.snippet).toBe('Heading: Raft Log Replication');
        expect(headingProj?.openIntent?.route).toBe('/admin/article/edit/101#heading-raft');

        const blockProj = await resolver.resolveNodeReference(blockNode, testContext);
        expect(blockProj?.status).toBe('current');
        expect(blockProj?.snippet).toBe('Block: Quorum intersection invariant must hold.');
        expect(blockProj?.openIntent?.route).toBe('/admin/article/edit/101?block=blk-quorum');
    });

    it('handles missing heading and missing block gracefully', async () => {
        const headingNode: AuthoringCanvasHeadingReferenceNode = {
            id: 'node-h-missing',
            type: 'heading-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 101,
            targetHeadingId: 'non-existent-heading'
        };

        const proj = await resolver.resolveNodeReference(headingNode, testContext);
        expect(proj?.status).toBe('heading-missing');
    });

    it('enforces privacy: returns permission-denied without leaking title or snippet to unauthorized users', async () => {
        const node: AuthoringCanvasArticleReferenceNode = {
            id: 'node-secret',
            type: 'article-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 102
        };

        const proj = await resolver.resolveNodeReference(node, testContext);
        expect(proj?.status).toBe('permission-denied');
        expect(proj?.title).toBeUndefined();
        expect(proj?.snippet).toBeUndefined();
    });

    it('identifies archived and missing articles', async () => {
        const archivedNode: AuthoringCanvasArticleReferenceNode = {
            id: 'node-archived',
            type: 'article-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 103
        };

        const missingNode: AuthoringCanvasArticleReferenceNode = {
            id: 'node-missing',
            type: 'article-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 99999
        };

        const archProj = await resolver.resolveNodeReference(archivedNode, testContext);
        expect(archProj?.status).toBe('archived');

        const missProj = await resolver.resolveNodeReference(missingNode, testContext);
        expect(missProj?.status).toBe('missing');
    });

    it('supports abort signal for request cancellation', async () => {
        const controller = new AbortController();
        controller.abort();

        const node: AuthoringCanvasArticleReferenceNode = {
            id: 'node-abort',
            type: 'article-reference',
            x: 0,
            y: 0,
            width: 250,
            height: 120,
            targetArticleId: 101
        };

        await expect(resolver.resolveNodeReference(node, testContext, controller.signal)).rejects.toThrow();
    });
});
