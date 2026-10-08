import { articleGraphEdgeKinds, articleGraphLimits } from '@/services/authoring/articleGraphQuery';
import type { ArticleGraphIdentity, ArticleGraphRequest, ArticleGraphResult } from '@/services/authoring/articleGraphQuery';

export const graphIdentity: ArticleGraphIdentity = { actor: 'actor', site: 'site', permissionDigest: 'a'.repeat(64), rootArticle: 'article-00000', rootRevision: 'revision', documentEpoch: 'epoch', indexGeneration: 'index' };
export const graphRequest: ArticleGraphRequest = { schemaVersion: 1, identity: graphIdentity, sessionId: 'session', sequence: 1, scope: 'current-editable', requestedDepth: 1, explicitExpansion: false, filters: { categories: [], tags: [], kinds: articleGraphEdgeKinds }, budget: articleGraphLimits };

export function graphResult(request: ArticleGraphRequest, count = 3): ArticleGraphResult {
    const nodes = Array.from({ length: count }, (_, index) => ({ articleIdentity: `article-${String(index).padStart(5, '0')}`, revisionIdentity: 'revision', title: `Article ${index}`, lifecycle: 'draft' as const }));
    const edges = nodes.slice(1).map((node, index) => ({ relationIdentity: `relation-${String(index).padStart(5, '0')}`, sourceArticle: request.identity.rootArticle, targetArticle: node.articleIdentity, kind: articleGraphEdgeKinds[index % 4]!, resolution: 'resolved' as const, source: { articleIdentity: request.identity.rootArticle, revisionIdentity: 'revision', documentEpoch: 'epoch', start: index * 4, end: index * 4 + 3, recordDigest: 'b'.repeat(64) } }));
    return { schemaVersion: 1, identity: request.identity, sessionId: request.sessionId, sequence: request.sequence, requestedDepth: request.requestedDepth, effectiveDepth: request.requestedDepth, status: 'complete', reason: null, nodes, edges, sourceDigest: 'c'.repeat(64), requestDigest: 'e'.repeat(64), contentDigest: 'd'.repeat(64) };
}
