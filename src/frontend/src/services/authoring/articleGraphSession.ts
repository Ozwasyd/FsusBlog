import { runArticleGraphLayoutTask } from './articleGraphLayout';
import {
    admitArticleGraphResult,
    articleGraphEdgeKinds,
    articleGraphLimits,
    unavailableArticleGraphHost,
    unavailableArticleGraphResult
} from './articleGraphQuery';

import type { ArticleGraphLayout, ArticleGraphLayoutOutcome, ArticleGraphLayoutRunner } from './articleGraphLayout';
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


export interface ArticleGraphSessionState {
    readonly request: ArticleGraphRequest | null;
    readonly result: ArticleGraphResult | null;
    readonly layout: ArticleGraphLayout | null;
    readonly pending: boolean;
    readonly layoutOutcome: (Pick<ArticleGraphLayoutOutcome, 'status' | 'reason'> & { readonly usage: ArticleGraphLayoutOutcome['usage'] | null; }) | null;
    readonly selectedNode: string | null;
    readonly selectedEdge: string | null;
    readonly navigationStatus: 'idle' | 'pending' | 'complete' | 'unavailable' | 'failed';
}

const emptyState = (): ArticleGraphSessionState => Object.freeze({ request: null, result: null, layout: null, layoutOutcome: null, pending: false, selectedNode: null, selectedEdge: null, navigationStatus: 'idle' });

/** The only graph state owner. Closing/invalidation erases facts and aborts outstanding query/navigation work. */
export class ArticleGraphSession
{
    private readonly host: ArticleGraphQueryHost;
    private readonly navigation: (ArticleGraphNavigationHost) | undefined;
    private readonly changed: ((state: ArticleGraphSessionState) => void) | undefined;
    private readonly layoutRunner: ArticleGraphLayoutRunner;
    private stateValue = emptyState();
    private generation = 0;
    private controller: AbortController | null = null;
    private navigationController: AbortController | null = null;
    private layoutController: AbortController | null = null;
    private layoutGeneration = 0;

    public constructor(
        host: ArticleGraphQueryHost = unavailableArticleGraphHost,
        navigation?: ArticleGraphNavigationHost,
        changed?: (state: ArticleGraphSessionState) => void,
        layoutRunner: ArticleGraphLayoutRunner = runArticleGraphLayoutTask
    )
    {
        this.host = host;
        this.navigation = navigation;
        this.changed = changed;
        this.layoutRunner = layoutRunner;
    }

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
        this.layoutController?.abort();
        this.layoutGeneration++;
        this.layoutController = null;
        this.controller = null;
        this.navigationController = null;
        this.update(emptyState());
    }

    public async resetLayout(): Promise<void>
    {
        const result = this.state.result;
        if (result && (result.status === 'complete' || result.status === 'truncated'))
        {
            await this.settleLayout(result, this.generation);
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
        this.layoutController?.abort();
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
            if (result.status === 'complete' || result.status === 'truncated')
            {
                await this.settleLayout(result, generation);
            }
            else
            {
                this.update({ ...this.state, result, layout: null, pending: false });
            }
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

    private async settleLayout(result: ArticleGraphResult, generation: number): Promise<void>
    {
        this.layoutController?.abort();
        const controller = new AbortController();
        this.layoutController = controller;
        const layoutGeneration = ++this.layoutGeneration;
        this.update({ ...this.state, result, layout: null, layoutOutcome: null, pending: true });
        try
        {
            const outcome = await this.layoutRunner(result, controller.signal);
            if (!controller.signal.aborted && generation === this.generation && layoutGeneration === this.layoutGeneration)
            {
                this.update({ ...this.state, layout: outcome.layout,
                    layoutOutcome: Object.freeze({ status: outcome.status, reason: outcome.reason, usage: outcome.usage }), pending: false });
            }
        }
        catch
        {
            if (!controller.signal.aborted && generation === this.generation && layoutGeneration === this.layoutGeneration)
            {
                // A rejected runner has no timing/resource receipt. Keep source facts available in the list.
                this.update({ ...this.state, layout: null, layoutOutcome: Object.freeze({ status: 'blocked', reason: 'layout-error', usage: null }), pending: false });
            }
        }
        finally
        {
            if (this.layoutController === controller)
            {
                this.layoutController = null;
            }
        }
    }

    private update(state: ArticleGraphSessionState): void
    {
        this.stateValue = Object.freeze(state);
        this.changed?.(this.stateValue);
    }
}
