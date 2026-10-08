import { describe, expect, it, vi } from 'vitest';
import { admitArticleGraphResult } from '@/services/authoring/articleGraphQuery';
import { ArticleGraphSession, layoutArticleGraph } from '@/services/authoring/articleGraphSession';
import type { ArticleGraphRequest, ArticleGraphResult } from '@/services/authoring/articleGraphQuery';
import { graphIdentity, graphRequest, graphResult } from './articleGraphFixtures';

describe('single transient graph session', () => {
    it('defaults every open and reopen to depth one and unavailable without real source', async () => {
        const session = new ArticleGraphSession();
        await session.open(graphIdentity, 'first');
        expect(session.state.request?.requestedDepth).toBe(1);
        expect(session.state.result?.status).toBe('unavailable');
        expect(session.state.result?.nodes).toEqual([]);
        await session.setDepth(2);
        expect(session.state.request?.explicitExpansion).toBe(true);
        session.close();
        expect(session.state.result).toBeNull();
        await session.open(graphIdentity, 'second');
        expect(session.state.request?.requestedDepth).toBe(1);
    });

    it('explicit depth changes consume host result and collapse; filters reset to one', async () => {
        const query = vi.fn(async (request: ArticleGraphRequest) => graphResult(request));
        const session = new ArticleGraphSession({ query });
        await session.open(graphIdentity, 'first');
        await session.setDepth(2);
        expect(session.state.result?.effectiveDepth).toBe(2);
        await session.setDepth(1);
        expect(session.state.result?.requestedDepth).toBe(1);
        await session.setDepth(2);
        await session.setFilters({ categories: ['category'], tags: ['tag'], kinds: ['link'] }, 'published');
        expect(query.mock.lastCall?.[0]).toMatchObject({ scope: 'published', requestedDepth: 1, explicitExpansion: false });
    });

    it.each(['actor', 'site', 'permissionDigest', 'rootRevision', 'documentEpoch', 'indexGeneration'] as const)('refuses %s identity drift without preserving facts', async field => {
        const session = new ArticleGraphSession({ query: async request => ({ ...graphResult(request), identity: { ...request.identity, [field]: 'changed' } }) });
        await session.open(graphIdentity, 'first');
        expect(session.state.result?.status).toBe('refused');
        expect(session.state.result?.nodes).toEqual([]);
        expect(session.state.layout).toBeNull();
    });

    it('aborts previous work and rejects late results after root switch/close', async () => {
        const pending: { request: ArticleGraphRequest; signal: AbortSignal; resolve: (result: ArticleGraphResult) => void }[] = [];
        const session = new ArticleGraphSession({ query: (request, signal) => new Promise(resolve => pending.push({ request, signal, resolve })) });
        const old = session.open(graphIdentity, 'first');
        const current = session.open({ ...graphIdentity, rootArticle: 'article-00001' }, 'second');
        expect(pending[0]!.signal.aborted).toBe(true);
        expect(session.state.result).toBeNull();
        pending[1]!.resolve(graphResult(pending[1]!.request));
        await current;
        const exact = session.state.result;
        pending[0]!.resolve(graphResult(pending[0]!.request));
        await old;
        expect(session.state.result).toBe(exact);
        session.close();
        expect(session.state).toMatchObject({ request: null, result: null, layout: null });
    });

    it('cancel clears facts immediately and aborts navigation and query', async () => {
        let navigationSignal: AbortSignal | undefined;
        const session = new ArticleGraphSession({ query: async request => graphResult(request) }, {
            openOrActivate: async (_node, signal) => { navigationSignal = signal; }, revealSource: vi.fn()
        });
        await session.open(graphIdentity, 'first');
        await session.openNode(graphIdentity.rootArticle);
        const deferred = new ArticleGraphSession({ query: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })) });
        const task = deferred.open(graphIdentity, 'first');
        deferred.cancel();
        await task;
        expect(deferred.state.result?.status).toBe('cancelled');
        expect(deferred.state.result?.nodes).toEqual([]);
        expect(navigationSignal).toBeDefined();
    });

    it.each([1, 100, 1000])('deterministically lays out %i nodes without timers, animation or persistence', count => {
        const frames = vi.spyOn(globalThis, 'requestAnimationFrame');
        const storage = vi.spyOn(globalThis.localStorage, 'setItem');
        const result = graphResult(graphRequest, count);
        const first = layoutArticleGraph(result);
        const second = layoutArticleGraph({ ...result, nodes: [...result.nodes].reverse(), edges: [...result.edges].reverse() });
        expect(first).toEqual(second);
        expect(first.positions).toHaveLength(count);
        expect(new Set(first.positions.map(position => `${position.x}:${position.y}`)).size).toBe(count);
        expect(first.positions.every(position => position.x >= 0 && position.x < first.width && position.y >= 0 && position.y < first.height)).toBe(true);
        expect(frames).not.toHaveBeenCalled();
        expect(storage).not.toHaveBeenCalled();
        frames.mockRestore();
        storage.mockRestore();
    });

    it('rejects ten thousand before layout allocation', () => {
        const result = graphResult(graphRequest, 10000);
        expect(() => admitArticleGraphResult(graphRequest, result)).toThrow('source-budget');
        expect(() => layoutArticleGraph(result)).toThrow('layout-budget');
    });

    it('drag is ephemeral; reset and reopen recompute without changing facts', async () => {
        const result = graphResult(graphRequest);
        const session = new ArticleGraphSession({ query: async request => ({ ...result, sessionId: request.sessionId, sequence: request.sequence }) });
        await session.open(graphIdentity, 'first');
        const facts = JSON.stringify(session.state.result);
        const initial = session.state.layout;
        session.moveNode(graphIdentity.rootArticle, 30, 30);
        expect(session.state.layout).not.toEqual(initial);
        expect(JSON.stringify(session.state.result)).toBe(facts);
        session.resetLayout();
        expect(session.state.layout).toEqual(initial);
        expect(() => session.moveNode(graphIdentity.rootArticle, Infinity, 0)).toThrow('invalid-position');
        expect(Object.isFrozen(session.state.result?.nodes)).toBe(true);
    });

    it('opens exact node and reveals exact upstream relation range; no navigation fallback', async () => {
        const openOrActivate = vi.fn();
        const revealSource = vi.fn();
        const session = new ArticleGraphSession({ query: async request => graphResult(request) }, { openOrActivate, revealSource });
        await session.open(graphIdentity, 'first');
        await session.openNode('article-00001');
        expect(openOrActivate.mock.calls[0]![0]).toBe(session.state.result!.nodes[1]);
        await session.revealEdge('relation-00000');
        expect(revealSource.mock.calls[0]![0]).toBe(session.state.result!.edges[0]);
        expect(revealSource.mock.calls[0]![0].source).toMatchObject({ start: 0, end: 3, recordDigest: 'b'.repeat(64) });
        const missing = new ArticleGraphSession({ query: async request => graphResult(request) });
        await missing.open(graphIdentity, 'first');
        await missing.openNode(graphIdentity.rootArticle);
        expect(missing.state.navigationStatus).toBe('unavailable');
    });

    it('refuses anonymous targets, false completeness, duplicate identities and nonempty refusals', () => {
        const result = graphResult(graphRequest);
        expect(() => admitArticleGraphResult(graphRequest, { ...result, status: 'refused' })).toThrow('nonempty-refusal');
        expect(() => admitArticleGraphResult(graphRequest, { ...result, status: 'truncated', reason: null })).toThrow('invalid-projection');
        expect(() => admitArticleGraphResult(graphRequest, { ...result, nodes: [...result.nodes, result.nodes[0]!] })).toThrow('invalid-node');
        expect(() => admitArticleGraphResult(graphRequest, { ...result, edges: [{ ...result.edges[0]!, targetArticle: 'private' }] })).toThrow('invalid-edge');
        expect(() => admitArticleGraphResult(graphRequest, { ...result, positions: [] } as ArticleGraphResult)).toThrow('unknown-field');
        expect(() => admitArticleGraphResult(graphRequest, { ...result, nodes: [{ ...result.nodes[0]!, cover: 'private-cover' }] } as ArticleGraphResult)).toThrow('invalid-node');
    });
});
