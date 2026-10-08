/** Integration projection, not a wire codec. Only the original AEDS/authenticated query host supplies these facts. */
export const articleGraphLimits = Object.freeze({ nodes: 1000, edges: 2000, payloadBytes: 1_048_576, indexOperations: 4096, queryMilliseconds: 250 });
export const articleGraphEdgeKinds = ['link', 'embed', 'broken', 'visibility-risk'] as const;
export type ArticleGraphEdgeKind = typeof articleGraphEdgeKinds[number];
export type ArticleGraphDepth = 1 | 2;
export type ArticleGraphScope = 'current-editable' | 'published';
export type ArticleGraphStatus = 'complete' | 'truncated' | 'unavailable' | 'refused' | 'stale' | 'cancelled';

export interface ArticleGraphIdentity {
    readonly actor: string;
    readonly site: string;
    readonly permissionDigest: string;
    readonly rootArticle: string;
    readonly rootRevision: string;
    readonly documentEpoch: string;
    readonly indexGeneration: string;
}

export interface ArticleGraphFilters {
    readonly categories: readonly string[];
    readonly tags: readonly string[];
    readonly kinds: readonly ArticleGraphEdgeKind[];
}

export interface ArticleGraphRequest {
    readonly schemaVersion: 1;
    readonly identity: ArticleGraphIdentity;
    readonly sessionId: string;
    readonly sequence: number;
    readonly scope: ArticleGraphScope;
    readonly requestedDepth: ArticleGraphDepth;
    readonly explicitExpansion: boolean;
    readonly filters: ArticleGraphFilters;
    readonly budget: typeof articleGraphLimits;
}

export interface ArticleGraphNode {
    readonly articleIdentity: string;
    readonly revisionIdentity: string;
    readonly title: string;
    readonly lifecycle: 'draft' | 'scheduled' | 'published' | 'archived' | 'deleted';
}

export interface ArticleGraphSource {
    readonly articleIdentity: string;
    readonly revisionIdentity: string;
    readonly documentEpoch: string;
    readonly start: number;
    readonly end: number;
    readonly recordDigest: string;
}

export interface ArticleGraphEdge {
    readonly relationIdentity: string;
    readonly sourceArticle: string;
    readonly targetArticle: string | null;
    readonly kind: ArticleGraphEdgeKind;
    readonly resolution: 'resolved' | 'missing-target' | 'missing-anchor' | 'deleted' | 'archived' | 'unauthorized' | 'private' | 'draft' | 'stale' | 'ambiguous' | 'unsupported';
    readonly source: ArticleGraphSource;
}

export interface ArticleGraphResult {
    readonly schemaVersion: 1;
    readonly identity: ArticleGraphIdentity;
    readonly sessionId: string;
    readonly sequence: number;
    readonly requestedDepth: ArticleGraphDepth;
    readonly effectiveDepth: 0 | ArticleGraphDepth;
    readonly status: ArticleGraphStatus;
    readonly reason: string | null;
    readonly nodes: readonly ArticleGraphNode[];
    readonly edges: readonly ArticleGraphEdge[];
    readonly sourceDigest: string;
    readonly requestDigest: string;
    readonly contentDigest: string;
}

/** The host owns permission trimming, budgets and exact transport digest verification before this boundary. */
export interface ArticleGraphQueryHost {
    query(request: ArticleGraphRequest, signal: AbortSignal): Promise<ArticleGraphResult>;
}

/** No routes, titles or text search may substitute for these canonical identity-based actions. */
export interface ArticleGraphNavigationHost {
    openOrActivate(node: ArticleGraphNode, signal: AbortSignal): Promise<void>;
    revealSource(edge: ArticleGraphEdge, signal: AbortSignal): Promise<void>;
}

export function sameArticleGraphIdentity(left: ArticleGraphIdentity, right: ArticleGraphIdentity): boolean
{
    return left.actor === right.actor && left.site === right.site && left.permissionDigest === right.permissionDigest
        && left.rootArticle === right.rootArticle && left.rootRevision === right.rootRevision
        && left.documentEpoch === right.documentEpoch && left.indexGeneration === right.indexGeneration;
}

export function unavailableArticleGraphResult(request: ArticleGraphRequest, status: ArticleGraphStatus = 'unavailable', reason = 'relation-api-unavailable'): ArticleGraphResult
{
    return Object.freeze({ schemaVersion: 1, identity: request.identity, sessionId: request.sessionId, sequence: request.sequence,
        requestedDepth: request.requestedDepth, effectiveDepth: 0, status, reason, nodes: Object.freeze([]), edges: Object.freeze([]), sourceDigest: '', requestDigest: '', contentDigest: '' });
}

export const unavailableArticleGraphHost: ArticleGraphQueryHost = {
    query(request, signal)
    {
        return Promise.resolve(unavailableArticleGraphResult(request, signal.aborted ? 'cancelled' : 'unavailable'));
    }
};

/** Defensive admission refuses malformed source results wholesale; it never filters private nodes in the client. */
export function admitArticleGraphResult(request: ArticleGraphRequest, result: ArticleGraphResult): ArticleGraphResult
{
    const digest = /^[a-f0-9]{64}$/u;
    const id = /^[a-zA-Z0-9._:-]{1,128}$/u;
    const closed = (value: object, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
    if (!closed(result, ['schemaVersion', 'identity', 'sessionId', 'sequence', 'requestedDepth', 'effectiveDepth', 'status', 'reason', 'nodes', 'edges', 'sourceDigest', 'requestDigest', 'contentDigest'])
        || !closed(result.identity, ['actor', 'site', 'permissionDigest', 'rootArticle', 'rootRevision', 'documentEpoch', 'indexGeneration']))
    {
        throw new Error('unknown-field');
    }
    if (result.schemaVersion !== 1 || !sameArticleGraphIdentity(request.identity, result.identity)
        || result.sessionId !== request.sessionId || result.sequence !== request.sequence || result.requestedDepth !== request.requestedDepth)
    {
        throw new Error('stale-identity');
    }
    if (result.nodes.length > articleGraphLimits.nodes || result.edges.length > articleGraphLimits.edges)
    {
        throw new Error('source-budget');
    }
    if (!['complete', 'truncated', 'unavailable', 'refused', 'stale', 'cancelled'].includes(result.status))
    {
        throw new Error('invalid-status');
    }
    if (result.status !== 'complete' && result.status !== 'truncated')
    {
        if (result.nodes.length || result.edges.length || result.effectiveDepth !== 0)
        {
            throw new Error('nonempty-refusal');
        }
        return unavailableArticleGraphResult(request, result.status, result.status === 'unavailable' ? 'relation-api-unavailable' : result.status);
    }
    if (!digest.test(result.contentDigest) || !digest.test(result.sourceDigest) || !digest.test(result.requestDigest)
        || result.effectiveDepth < 1 || result.effectiveDepth > result.requestedDepth
        || result.status === 'complete' && (result.reason !== null || result.effectiveDepth !== result.requestedDepth)
        || result.status === 'truncated' && !['node-budget', 'edge-budget', 'payload-budget', 'index-budget', 'time-budget'].includes(result.reason ?? ''))
    {
        throw new Error('invalid-projection');
    }
    const identities = new Set<string>();
    const revisions = new Map<string, string>();
    const nodes = result.nodes.map(node =>
    {
        if (!closed(node, ['articleIdentity', 'revisionIdentity', 'title', 'lifecycle'])
            || !id.test(node.articleIdentity) || !id.test(node.revisionIdentity) || node.title.length > 256
            || identities.has(node.articleIdentity) || !['draft', 'scheduled', 'published', 'archived', 'deleted'].includes(node.lifecycle))
        {
            throw new Error('invalid-node');
        }
        identities.add(node.articleIdentity);
        revisions.set(node.articleIdentity, node.revisionIdentity);
        return Object.freeze({ ...node });
    });
    if (!identities.has(request.identity.rootArticle))
    {
        throw new Error('missing-root');
    }
    if (nodes.find(node => node.articleIdentity === request.identity.rootArticle)?.revisionIdentity !== request.identity.rootRevision)
    {
        throw new Error('stale-root');
    }
    const relations = new Set<string>();
    const edges = result.edges.map(edge =>
    {
        if (!closed(edge, ['relationIdentity', 'sourceArticle', 'targetArticle', 'kind', 'resolution', 'source'])
            || !closed(edge.source, ['articleIdentity', 'revisionIdentity', 'documentEpoch', 'start', 'end', 'recordDigest'])
            || !id.test(edge.relationIdentity) || relations.has(edge.relationIdentity) || !identities.has(edge.sourceArticle)
            || edge.targetArticle !== null && !identities.has(edge.targetArticle)
            || edge.targetArticle === null && edge.kind !== 'broken' && edge.kind !== 'visibility-risk'
            || !request.filters.kinds.includes(edge.kind) || edge.source.articleIdentity !== edge.sourceArticle
            || !['resolved', 'missing-target', 'missing-anchor', 'deleted', 'archived', 'unauthorized', 'private', 'draft', 'stale', 'ambiguous', 'unsupported'].includes(edge.resolution)
            || revisions.get(edge.sourceArticle) !== edge.source.revisionIdentity
            || !id.test(edge.source.revisionIdentity) || !id.test(edge.source.documentEpoch) || !digest.test(edge.source.recordDigest)
            || !Number.isSafeInteger(edge.source.start) || !Number.isSafeInteger(edge.source.end)
            || edge.source.start < 0 || edge.source.end <= edge.source.start)
        {
            throw new Error('invalid-edge');
        }
        relations.add(edge.relationIdentity);
        return Object.freeze({ ...edge, source: Object.freeze({ ...edge.source }) });
    });
    if (new TextEncoder().encode(JSON.stringify(result)).length > articleGraphLimits.payloadBytes)
    {
        throw new Error('source-budget');
    }
    return Object.freeze({ ...result, identity: Object.freeze({ ...result.identity }), nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
}
