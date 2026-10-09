import {
    admitArticleGraphResult,
    articleGraphEdgeKinds,
    articleGraphLimits,
    unavailableArticleGraphHost,
    unavailableArticleGraphResult
} from './articleGraphQuery';

import type {
    ArticleGraphDepth,
    ArticleGraphFilters,
    ArticleGraphIdentity,
    ArticleGraphNavigationHost,
    ArticleGraphQueryHost,
    ArticleGraphRequest,
    ArticleGraphResult,
    ArticleGraphScope
} from './articleGraphQuery';

export interface ArticleGraphPosition {
    readonly articleIdentity: string;
    readonly x: number;
    readonly y: number;
}

export interface ArticleGraphLayout {
    readonly algorithm: 'stable-grid-v1';
    readonly width: number;
    readonly height: number;
    readonly positions: readonly ArticleGraphPosition[];
    readonly nodeOrder: readonly string[];
    readonly edgeOrder: readonly string[];
}

const compareIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/** A single bounded static pass: no workers, force loop, clock, randomness or persistent position authority. */
export function layoutArticleGraph(result: ArticleGraphResult): ArticleGraphLayout
{
    if (result.nodes.length > articleGraphLimits.nodes || result.edges.length > articleGraphLimits.edges)
    {
        throw new Error('layout-budget');
    }
    const nodeOrder = result.nodes.map(node => node.articleIdentity).sort(compareIds);
    const rootIndex = nodeOrder.indexOf(result.identity.rootArticle);
    if (rootIndex >= 0)
    {
        nodeOrder.splice(rootIndex, 1);
        nodeOrder.unshift(result.identity.rootArticle);
    }
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodeOrder.length)));
    const positions = nodeOrder.map((articleIdentity, index) => Object.freeze({ articleIdentity, x: 80 + index % columns * 160, y: 50 + Math.floor(index / columns) * 100 }));
    return Object.freeze({ algorithm: 'stable-grid-v1', width: columns * 160, height: Math.max(100, Math.ceil(nodeOrder.length / columns) * 100), positions: Object.freeze(positions), nodeOrder: Object.freeze(nodeOrder), edgeOrder: Object.freeze(result.edges.map(edge => edge.relationIdentity).sort(compareIds)) });
}

export interface ArticleGraphSessionState {
    readonly request: ArticleGraphRequest | null;
    readonly result: ArticleGraphResult | null;
    readonly layout: ArticleGraphLayout | null;
    readonly pending: boolean;
    readonly selectedNode: string | null;
    readonly selectedEdge: string | null;
    readonly navigationStatus: 'idle' | 'pending' | 'complete' | 'unavailable' | 'failed';
}

const emptyState = (): ArticleGraphSessionState => Object.freeze({ request: null, result: null, layout: null, pending: false, selectedNode: null, selectedEdge: null, navigationStatus: 'idle' });

/** The only graph state owner. Closing/invalidation erases facts and aborts outstanding query/navigation work. */
export class ArticleGraphSession
{
    private stateValue = emptyState();
    private generation = 0;
    private controller: AbortController | null = null;
    private navigationController: AbortController | null = null;

    public constructor(
        private readonly host: ArticleGraphQueryHost = unavailableArticleGraphHost,
        private readonly navigation?: ArticleGraphNavigationHost,
        private readonly changed?: (state: ArticleGraphSessionState) => void
    )
    {}

    public get state(): ArticleGraphSessionState
    {
        return this.stateValue;
    }

    public open(identity: ArticleGraphIdentity, sessionId: string): Promise<void>
    {
        this.close();
        return this.query(Object.freeze({ schemaVersion: 1, identity: Object.freeze({ ...identity }), sessionId, sequence: this.generation,
            scope: 'current-editable', requestedDepth: 1, explicitExpansion: false,
            filters: Object.freeze({ categories: Object.freeze([]), tags: Object.freeze([]), kinds: articleGraphEdgeKinds }), budget: articleGraphLimits }));
    }

    public setDepth(depth: ArticleGraphDepth): Promise<void>
    {
        if (depth !== 1 && depth !== 2)
        {
            throw new Error('invalid-depth');
        }
        const request = this.state.request;
        if (!request)
        {
            throw new Error('closed-session');
        }
        return this.query(Object.freeze({ ...request, requestedDepth: depth, explicitExpansion: depth === 2, sequence: this.generation + 1 }));
    }

    public setFilters(filters: ArticleGraphFilters, scope: ArticleGraphScope): Promise<void>
    {
        const request = this.state.request;
        if (!request)
        {
            throw new Error('closed-session');
        }
        if (!['current-editable', 'published'].includes(scope) || filters.categories.length > 32 || filters.tags.length > 32
            || !filters.kinds.length || filters.kinds.some(kind => !articleGraphEdgeKinds.includes(kind))
            || filters.categories.some(value => !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value))
            || filters.tags.some(value => !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value))
            || new Set(filters.kinds).size !== filters.kinds.length
            || new Set(filters.categories).size !== filters.categories.length
            || new Set(filters.tags).size !== filters.tags.length)
        {
            throw new Error('invalid-filter');
        }
        const frozenFilters = Object.freeze({ categories: Object.freeze([...filters.categories]), tags: Object.freeze([...filters.tags]), kinds: Object.freeze([...filters.kinds]) });
        return this.query(Object.freeze({ ...request, filters: frozenFilters, scope, requestedDepth: 1, explicitExpansion: false, sequence: this.generation + 1 }));
    }

    public cancel(): void
    {
        const request = this.state.request;
        this.close();
        if (request)
        {
            this.update({ ...emptyState(), request, result: unavailableArticleGraphResult(request, 'cancelled', 'cancelled') });
        }
    }

    public close(): void
    {
        this.generation++;
        this.controller?.abort();
        this.navigationController?.abort();
        this.controller = null;
        this.navigationController = null;
        this.update(emptyState());
    }

    public resetLayout(): void
    {
        if (this.state.result)
        {
            this.update({ ...this.state, layout: layoutArticleGraph(this.state.result) });
        }
    }

    public moveNode(articleIdentity: string, x: number, y: number): void
    {
        const layout = this.state.layout;
        if (!layout || !layout.nodeOrder.includes(articleIdentity) || !Number.isFinite(x) || !Number.isFinite(y) || x < 16 || y < 16 || x > layout.width - 16 || y > layout.height - 16)
        {
            throw new Error('invalid-position');
        }
        this.update({ ...this.state, layout: Object.freeze({ ...layout, positions: Object.freeze(layout.positions.map(position => position.articleIdentity === articleIdentity ? Object.freeze({ articleIdentity, x, y }) : position)) }) });
    }

    public selectNode(articleIdentity: string): void
    {
        if (!this.state.result?.nodes.some(node => node.articleIdentity === articleIdentity))
        {
            throw new Error('unknown-node');
        }
        this.update({ ...this.state, selectedNode: articleIdentity, selectedEdge: null });
    }

    public async openNode(articleIdentity: string): Promise<void>
    {
        const node = this.state.result?.nodes.find(candidate => candidate.articleIdentity === articleIdentity);
        if (!node)
        {
            throw new Error('unknown-node');
        }
        this.selectNode(articleIdentity);
        await this.navigate(signal => this.navigation!.openOrActivate(node, signal));
    }

    public async revealEdge(relationIdentity: string): Promise<void>
    {
        const edge = this.state.result?.edges.find(candidate => candidate.relationIdentity === relationIdentity);
        if (!edge)
        {
            throw new Error('unknown-edge');
        }
        this.update({ ...this.state, selectedNode: null, selectedEdge: relationIdentity });
        await this.navigate(signal => this.navigation!.revealSource(edge, signal));
    }

    private async navigate(action: (signal: AbortSignal) => Promise<void>): Promise<void>
    {
        this.navigationController?.abort();
        if (!this.navigation)
        {
            this.update({ ...this.state, navigationStatus: 'unavailable' });
            return;
        }
        const controller = new AbortController();
        this.navigationController = controller;
        const generation = this.generation;
        this.update({ ...this.state, navigationStatus: 'pending' });
        try
        {
            await action(controller.signal);
            if (!controller.signal.aborted && generation === this.generation)
            {
                this.update({ ...this.state, navigationStatus: 'complete' });
            }
        }
        catch
        {
            if (!controller.signal.aborted && generation === this.generation)
            {
                this.update({ ...this.state, navigationStatus: 'failed' });
            }
        }
        finally
        {
            if (this.navigationController === controller)
            {
                this.navigationController = null;
            }
        }
    }

    private async query(request: ArticleGraphRequest): Promise<void>
    {
        this.controller?.abort();
        this.navigationController?.abort();
        const controller = new AbortController();
        this.controller = controller;
        const generation = ++this.generation;
        this.update({ ...emptyState(), request, pending: true });
        try
        {
            const candidate = await this.host.query(request, controller.signal);
            if (controller.signal.aborted || generation !== this.generation)
            {
                return;
            }
            const result = admitArticleGraphResult(request, candidate);
            const layout = layoutArticleGraph(result);
            this.update({ ...this.state, result, layout, pending: false });
        }
        catch
        {
            if (!controller.signal.aborted && generation === this.generation)
            {
                this.update({ ...this.state, result: unavailableArticleGraphResult(request, 'refused', 'source-refused'), pending: false });
            }
        }
        finally
        {
            if (this.controller === controller)
            {
                this.controller = null;
            }
        }
    }

    private update(state: ArticleGraphSessionState): void
    {
        this.stateValue = Object.freeze(state);
        this.changed?.(this.stateValue);
    }
}
