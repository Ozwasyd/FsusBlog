import { validateArticleDocumentContext, type ArticleDocumentContext } from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

/** Read-only structural slice of original1975 AttachmentBusinessProjection, not an asset inventory. */
export interface ArticlePreviewAttachmentProjection {
    readonly schema: 'fsusblog.article-attachment-business.v1';
    readonly context: ArticleDocumentContext;
    readonly blockingNodeIds: readonly string[];
    readonly contentDigest: string;
}

/**
 * Pass the actual createArticleAttachmentBusinessState result from supplied8ff02b213.
 * Only its assess/verify methods are borrowed. Credentials, intent/reference/cleanup
 * authorities and upload transport remain owned by that original instance.
 */
export interface ArticlePreviewAttachmentPort<P extends ArticlePreviewAttachmentProjection = ArticlePreviewAttachmentProjection> {
    assess(signal?: AbortSignal): Promise<P>;
    verify(candidate: unknown, signal?: AbortSignal): Promise<boolean>;
}

export interface ArticlePreviewAttachmentState<P extends ArticlePreviewAttachmentProjection = ArticlePreviewAttachmentProjection> {
    readonly status: 'missing' | 'checking' | 'ready' | 'blocked' | 'stale' | 'canceled' | 'failed';
    /** The original immutable projection reference; no body, bytes or second ledger are created. */
    readonly projection: P | null;
    readonly reason: string | null;
}

/** Local identity/tamper rejection supplements, never replaces, the original owner's live verify. */
export function isCurrentArticlePreviewAttachmentProjection<P extends ArticlePreviewAttachmentProjection>(
    projection: P,
    context: ArticleDocumentContext
): boolean
{
    try
    {
        const { contentDigest, ...body } = projection;
        return projection.schema === 'fsusblog.article-attachment-business.v1'
            && Object.keys(projection).sort().join(',') === 'blockingNodeIds,contentDigest,context,items,previewResources,schema'
            && Object.isFrozen(projection)
            && validateArticleDocumentContext(projection.context)
            && projection.context.contextDigest === context.contextDigest
            && /^[a-f0-9]{64}$/u.test(contentDigest)
            && calculateOpenArticleDocumentDigest(body) === contentDigest
            && Array.isArray(projection.blockingNodeIds)
            && projection.blockingNodeIds.every(nodeId => typeof nodeId === 'string');
    }
    catch
    {
        return false;
    }
}
