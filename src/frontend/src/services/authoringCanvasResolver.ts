/**
 * Authoring Canvas Reference Resolver (#2483)
 *
 * Resolves article, heading, and block reference nodes into privacy-safe,
 * package-preview classification and an authenticated server-projection reader seam.
 * The preview resolver does not attest server permission or coordinate authority.
 */
import { type AuthoringCanvasArticleReferenceNode, type AuthoringCanvasBlockReferenceNode, type AuthoringCanvasHeadingReferenceNode, type AuthoringCanvasNode, type AuthoringCanvasOpenIntent, type AuthoringCanvasReferenceProjection, type AuthoringCanvasReferenceStatus } from '@/contracts/authoringCanvas';
export interface TargetArticleProviderItem
{
    id: number | string;
    title: string;
    revision: number | string;
    isArchived?: boolean;
    isDeleted?: boolean;
    allowedUserIds?: string[];
    headings?: {
        id: string;
        text: string;
    }[];
    blocks?: {
        id: string;
        previewText: string;
    }[];
    snippet?: string;
}
export interface TargetArticleProvider
{
    getArticle(id: number | string, context: ResolutionContext): Promise<TargetArticleProviderItem | null>;
    getArticlesBatch(ids: (number | string)[], context: ResolutionContext): Promise<Map<string | number, TargetArticleProviderItem>>;
}
export interface ResolutionContext
{
    userId: string;
    siteId: string;
    canvasId: string;
    canvasRevision: number;
}
function snippetOrEmpty(value: string | undefined): string
{
    if (value)
    {
        return value;
    }
    return '';
}
export class AuthoringCanvasResolver
{
    private readonly cache = new Map<string, AuthoringCanvasReferenceProjection>();
    private readonly articleProvider: TargetArticleProvider;
    constructor(articleProvider: TargetArticleProvider)
    {
        this.articleProvider = articleProvider;
    }
    private buildCacheKey(userId: string, siteId: string, nodeId: string, targetRevision?: number | string): string
    {
        return `${userId}:${siteId}:${nodeId}:${targetRevision ?? 'latest'}`;
    }
    async resolveNodeReference(node: AuthoringCanvasNode, context: ResolutionContext, signal?: AbortSignal): Promise<AuthoringCanvasReferenceProjection | null>
    {
        if (node.type !== 'article-reference' && node.type !== 'heading-reference' && node.type !== 'block-reference')
        {
            return null;
        }
        const map = await this.resolveReferences([node], context, signal);
        const projection = map.get(node.id);
        if (projection)
        {
            return projection;
        }
        return null;
    }
    async resolveReferences(nodes: AuthoringCanvasNode[], context: ResolutionContext, signal?: AbortSignal): Promise<Map<string, AuthoringCanvasReferenceProjection>>
    {
        const results = new Map<string, AuthoringCanvasReferenceProjection>();
        const refNodes = nodes.filter((n): n is AuthoringCanvasArticleReferenceNode | AuthoringCanvasHeadingReferenceNode | AuthoringCanvasBlockReferenceNode => n.type === 'article-reference' || n.type === 'heading-reference' || n.type === 'block-reference');
        if (refNodes.length === 0)
        {
            return results;
        }
        if (signal?.aborted)
        {
            throw new DOMException('Resolution aborted', 'AbortError');
        }
        // Batch unique target article IDs
        const targetIds = Array.from(new Set(refNodes.map((n) => n.targetArticleId)));
        const articlesMap = await this.articleProvider.getArticlesBatch(targetIds, context);
        if (signal?.aborted)
        {
            throw new DOMException('Resolution aborted', 'AbortError');
        }
        const now = new Date().toISOString();
        for (const node of refNodes)
        {
            const article = articlesMap.get(node.targetArticleId);
            let status: AuthoringCanvasReferenceStatus;
            let title: string | undefined;
            let snippet: string | undefined;
            let targetRevision: number | string | undefined;
            let openIntent: AuthoringCanvasOpenIntent | undefined;
            if (!article || article.isDeleted)
            {
                status = 'missing';
            }
            else if (article.isArchived)
            {
                status = 'archived';
            }
            else if (article.allowedUserIds && !article.allowedUserIds.includes(context.userId))
            {
                // Privacy-safe fail-closed: do not leak title or snippet
                status = 'permission-denied';
            }
            else
            {
                targetRevision = article.revision;
                title = article.title;
                snippet = snippetOrEmpty(article.snippet).slice(0, 180);
                if (node.type === 'heading-reference')
                {
                    const heading = article.headings?.find((h) => h.id === node.targetHeadingId);
                    if (!heading)
                    {
                        status = 'heading-missing';
                    }
                    else
                    {
                        snippet = heading.text ? `Heading: ${heading.text}` : snippet;
                        openIntent = {
                            articleId: article.id,
                            headingId: node.targetHeadingId,
                            route: `/admin/article/edit/${article.id}#${node.targetHeadingId}`
                        };
                        status = this.determinePinnedStatus(node.pinnedTargetRevision, article.revision);
                    }
                }
                else if (node.type === 'block-reference')
                {
                    const block = article.blocks?.find((b) => b.id === node.targetBlockId);
                    if (!block)
                    {
                        status = 'block-missing';
                    }
                    else
                    {
                        snippet = block.previewText ? `Block: ${block.previewText.slice(0, 120)}` : snippet;
                        openIntent = {
                            articleId: article.id,
                            blockId: node.targetBlockId,
                            route: `/admin/article/edit/${article.id}?block=${node.targetBlockId}`
                        };
                        status = this.determinePinnedStatus(node.pinnedTargetRevision, article.revision);
                    }
                }
                else
                {
                    // Standard article reference
                    openIntent = {
                        articleId: article.id,
                        route: `/admin/article/edit/${article.id}`
                    };
                    status = this.determinePinnedStatus(node.pinnedTargetRevision, article.revision);
                }
            }
            const rawProjection = {
                nodeId: node.id,
                nodeType: node.type,
                targetArticleId: node.targetArticleId,
                status,
                title: status === 'permission-denied' ? undefined : title,
                snippet: status === 'permission-denied' ? undefined : snippet,
                targetRevision,
                openIntent,
                resolvedAt: now
            };
            const digest = `prd_${node.id}_${status}_${targetRevision ?? 'none'}`;
            const projection: AuthoringCanvasReferenceProjection = {
                ...rawProjection,
                contentDigest: digest
            };
            results.set(node.id, projection);
            this.cache.set(this.buildCacheKey(context.userId, context.siteId, node.id, node.pinnedTargetRevision), projection);
        }
        return results;
    }
    private determinePinnedStatus(pinnedRevision: number | string | undefined, currentRevision: number | string): AuthoringCanvasReferenceStatus
    {
        if (pinnedRevision === undefined || pinnedRevision === null)
        {
            return 'current';
        }
        if (String(pinnedRevision) === String(currentRevision))
        {
            return 'pinned-current';
        }
        return 'pinned-stale';
    }
    clearCache(): void
    {
        this.cache.clear();
    }
}
/** Production reference reader consumes already-authorized server projections, not article bodies. */
export interface AuthoringCanvasProjectionReader
{
    resolveReferences(nodes: AuthoringCanvasNode[], context: ResolutionContext & {
        documentDigest: string;
    }, signal?: AbortSignal): Promise<Map<string, AuthoringCanvasReferenceProjection>>;
}
