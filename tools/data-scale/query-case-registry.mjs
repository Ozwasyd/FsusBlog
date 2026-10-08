import fs from 'node:fs';

import { computeSha256 } from './runtime-plan.mjs';

const protocol = JSON.parse(fs.readFileSync(new URL('../../src/shared/Contracts/Validation/aeds-protocol.json', import.meta.url), 'utf8'));
const frameTypes = new Map(protocol.frameTypes.map((frame) => [frame.name, frame.value]));

function frameName(id)
{
    if (id.startsWith('article-list'))
    {
        return 'ArticleList';
    }
    if (id.startsWith('article-detail'))
    {
        return 'ArticleDetail';
    }
    if (id.startsWith('comment-root'))
    {
        return 'CommentTreeRootCursor';
    }
    if (id === threadReplyCaseId)
    {
        return 'CommentThreadReplyCursor';
    }
    if (id === relatedReadingCaseId)
    {
        return 'ArticleRelatedReading';
    }
    if (id.startsWith('comment-nested'))
    {
        return 'CommentChildCursor';
    }
    if (id.startsWith('category') || id.startsWith('tag'))
    {
        return 'ArticleList';
    }
    return 'ArticleSearch';
}

export const queryCaseIds = Object.freeze([
    'article-list-first-page',
    'article-list-middle-page',
    'article-list-last-page',
    'article-list-deep-cursor',
    'comment-root-first',
    'comment-root-middle-cursor',
    'comment-root-last-cursor',
    'comment-nested-root-expansion',
    'category-largest',
    'category-empty',
    'tag-largest',
    'tag-empty',
    'article-detail-first',
    'article-detail-last',
    'search-title-canary',
    'search-body-canary'
]);

export const threadReplyCaseId = 'comment-thread-replies';
export const relatedReadingCaseId = 'article-related-prev-next';
export const queryRegistrySchemas = Object.freeze(['fsusblog.data-scale-query-registry.v1', 'fsusblog.data-scale-query-registry.v2', 'fsusblog.data-scale-query-registry.v3']);

/** Version additions stay with this single registry; v1's sixteen IDs remain frozen. */
export function queryCaseIdsForSchema(schema = queryRegistrySchemas[0])
{
    if (!queryRegistrySchemas.includes(schema))
    {
        throw new Error('unsupported query registry schema');
    }
    const ids = [...queryCaseIds];
    if (schema !== queryRegistrySchemas[0])
    {
        ids.push(threadReplyCaseId);
    }
    if (schema === queryRegistrySchemas[2])
    {
        ids.push(relatedReadingCaseId);
    }
    return ids;
}

/** Current canonical source has no qualified comment role/revision reader. Never trust a caller's verified flag. */
export function queryExecutionBlockers(id)
{
    if (id === threadReplyCaseId)
    {
        return ['canonical_comment_normalized_role_reader_unavailable', 'canonical_comment_exact_revision_reader_unavailable'];
    }
    return id === relatedReadingCaseId
        ? ['canonical_article_related_semantic_coordinates_missing', 'canonical_article_related_current_publication_receipt_missing'] : [];
}

export const queryMatrixTiers = Object.freeze(['scale-xs', 'scale-s', 'scale-m']);

/** Existing cases only. These describe tested coordinates, not broader query acceptance. */
export function buildQueryCaseInventory(binding, registrySchema = queryRegistrySchemas[0])
{
    requireQueryBinding(binding);
    const articleOwner = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs';
    const commentOwner = 'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs';
    const owner = (domain) =>
    {
        const sourcePath = domain === 'article' ? articleOwner : commentOwner;
        const contentDigest = computeSha256(fs.readFileSync(new URL(`../../${sourcePath}`, import.meta.url)));
        return { path: sourcePath, contentDigest,
            entrypoint: `FsusBlog.Server.Modules.Endpoints.Binary.BinaryEndpoints.MapBinary${domain === 'article' ? 'Article' : 'Comment'}Endpoints`,
            version: `source-${contentDigest.slice('sha256:'.length)}` };
    };
    const owners = { article: owner('article'), comment: owner('comment') };
    const cases = queryCaseIdsForSchema(registrySchema).map((id) =>
    {
        let domain = 'article';
        let kind;
        let routePattern;
        let inputFields;
        let parameters;
        let order = [{ field: 'createTime', direction: 'desc' }, { field: 'id', direction: 'desc' }];
        let pagination = 'cursor';
        if (id.startsWith('article-list'))
        {
            kind = 'latest-list';
            routePattern = '/api/binary/article/list/home/{page:int}/{size:int}.aeds';
            inputFields = ['publicArticles', 'pageSize'];
            parameters = ['page', 'size', 'cursor'];
        }
        else if (id.startsWith('comment'))
        {
            domain = 'comment';
            const child = id === 'comment-nested-root-expansion';
            kind = id === threadReplyCaseId ? 'public-thread' : id === 'comment-root-first' ? 'public-list' : 'pagination-order';
            routePattern = child ? '/api/binary/comment/{articleId:int}/children/{parentId:long}' : '/api/binary/comment/{articleId:int}';
            inputFields = ['visibleComments', 'canaries.commentArticleId', 'commentPageSize', ...(child ? ['canaries.nestedRootId'] : [])];
            parameters = ['articleId', ...(child ? ['parentId'] : []), 'limit', 'cursor'];
            order = [{ field: 'id', direction: child ? 'asc' : 'desc' }];
            if (id === threadReplyCaseId)
            {
                routePattern = '/api/binary/comment/{articleId:int}/thread/{rootId:long}';
                inputFields = ['threadReplies.articleId', 'threadReplies.rootId', 'threadReplies.pageSize', 'threadReplies.expectedReplies'];
                parameters = ['articleId', 'rootId', 'limit', 'cursor'];
                order = [{ field: 'id', direction: 'asc' }];
            }
        }
        else if (id.startsWith('category') || id.startsWith('tag'))
        {
            const type = id.startsWith('category') ? 'category' : 'tag';
            kind = `${type}-filter`;
            routePattern = `/api/binary/article/list/${type}/{${type}Id:int}/{page:int}/{size:int}.aeds`;
            inputFields = ['publicArticles', type === 'category' ? 'categories' : 'tags', 'pageSize'];
            parameters = [`${type}Id`, 'page', 'size', 'cursor'];
        }
        else if (id === relatedReadingCaseId)
        {
            kind = 'prev-next';
            routePattern = '/api/binary/article/{articleId:int}/related.aeds';
            inputFields = ['relatedReading.articleId', 'relatedReading.related', 'relatedReading.previous', 'relatedReading.next'];
            parameters = ['articleId'];
            order = [];
            pagination = 'none';
        }
        else if (id.startsWith('article-detail'))
        {
            kind = 'detail';
            routePattern = '/api/binary/article/{id}.aeds';
            inputFields = ['publicArticles'];
            parameters = ['id'];
            order = [];
            pagination = 'none';
        }
        else
        {
            kind = 'search-hit';
            routePattern = '/api/binary/article/search/query.aeds';
            inputFields = ['publicArticles', id === 'search-title-canary' ? 'canaries.titleSearch' : 'canaries.bodySearch'];
            parameters = ['q'];
            // The existing oracle supplies exact search IDs; it does not expose a ranking role contract.
            order = null;
            pagination = 'none';
        }
        return { id, domain, kind, queryOwner: owners[domain], routePattern,
            actorClass: 'anonymous', inputFields, parameters, order, tieBreakerField: order?.length ? 'id' : null,
            pagination, applicableTiers: [...queryMatrixTiers],
            canonicalRoleBindings: null, scenarioApplicability: null,
            blockers: ['canonical_input_role_bindings_missing', 'query_owner_scenario_receipt_intake_missing',
                ...(id === 'comment-nested-root-expansion' ? ['child_expansion_is_not_full_public_thread'] : []),
                ...queryExecutionBlockers(id),
                ...(order === null ? ['search_ranking_role_contract_missing'] : [])],
            ...(id === threadReplyCaseId ? { coverageScope: 'rooted-reply-cursor',
                requiredInputTypes: { articleId: 'positive Int32', rootId: 'positive Int64 decimal string', pageSize: 'integer 1..100',
                    expectedReplies: 'explicit ordered CommentReplyItemDto id/content/time/root/parent/depth/deleted/edited projection array' } } : {}),
            ...(id === relatedReadingCaseId ? { coverageScope: 'related-reading-prev-next-envelope',
                requiredInputTypes: { articleId: 'positive Int32', related: 'explicit ordered RelatedReadingItem array, at most six',
                    previous: 'explicit RelatedReadingItem or null', next: 'explicit RelatedReadingItem or null' } } : {}) };
    });
    const inventory = { schema: registrySchema.replace('-registry.', '-inventory.'), binding,
        qualification: 'not-performed', releaseEvidenceEligible: false, cases };
    return { ...inventory, contentDigest: computeSha256(inventory) };
}

/** Consume the catalog owner's kind vocabulary; never add or execute a query case. */
export function buildQuerySemanticOwnerInventory({ binding, kinds, registrySchema })
{
    requireQueryBinding(binding);
    if (!kinds || Object.keys(kinds).sort().join(',') !== 'article,comment'
        || Object.values(kinds).some((values) => !Array.isArray(values) || !values.length
            || values.some((value) => typeof value !== 'string') || new Set(values).size !== values.length))
    {
        throw new Error('explicit unique article/comment semantic vocabulary required');
    }
    const inventory = buildQueryCaseInventory(binding, registrySchema);
    const sourceRef = (sourcePath, entrypoint, parameterTypes) =>
    {
        const contentDigest = computeSha256(fs.readFileSync(new URL(`../../${sourcePath}`, import.meta.url)));
        return { path: sourcePath, entrypoint, contentDigest, version: `source-${contentDigest.slice('sha256:'.length)}`,
            ...(parameterTypes ? { parameterTypes } : {}) };
    };
    const article = (member) => sourceRef('src/backend/Interfaces/IArticleEndpointService.cs', `FsusBlog.Server.Interfaces.IArticleEndpointService.${member}`);
    const comment = (member) => sourceRef('src/backend/Services/CommentQueryService.cs', `FsusBlog.Server.Services.ICommentQueryService.${member}`);
    const authorQueue = () => sourceRef('src/backend/Services/Authoring/AuthoringUseCasePorts.cs',
        'FsusBlog.Server.Services.Authoring.IAuthoringModerationQueue.ListCommentModerationQueuePageAsync');
    const actorReads = () => [comment('GetAttributableAsync'),
        ...['GetUserCommentsAsync', 'GetUserCommentsForArticleAsync'].map((member) =>
            sourceRef('src/core/Services/Abstractions/ICommentCoreService.cs',
                `FsusBlog.Core.Services.Abstractions.ICommentCoreService.${member}`))];
    const publicCommentReads = () => ['GetTreeRootsAsync', 'GetChildrenAsync', 'GetPermalinkContextAsync', 'GetRepliesAsync'].map(comment);
    const publicCommentRoutes = () => ['/api/binary/comment/{articleId:int}',
        '/api/binary/comment/{articleId:int}/children/{parentId:long}',
        '/api/binary/comment/{articleId:int}/context/{commentId:long}',
        '/api/binary/comment/{articleId:int}/thread/{rootId:long}'];
    const visibilityProjection = () => sourceRef('src/backend/Infrastructure/Projections/CommentProjection.cs',
        'FsusBlog.Server.Infrastructure.Projections.CommentProjection.ToCoreModel');
    const projectionVerifier = () => sourceRef('src/backend/Services/Fixtures/CanonicalArticleProjectionVerifier.cs',
        'FsusBlog.Server.Services.Fixtures.CanonicalArticleProjectionVerifier.VerifyAsync',
        ['FsusBlog.Server.Services.Fixtures.CanonicalArticlePublicationReceipt',
            'FsusBlog.Server.Services.Fixtures.CanonicalArticlePublicationRequest', 'System.Threading.CancellationToken']);
    const requirements = [];
    for (const [domain, values] of Object.entries(kinds))
    {
        for (const kind of values)
        {
            let businessOwners;
            let routePatterns;
            let actorConstraint = 'AllowAnonymous';
            const blockers = ['canonical_input_role_bindings_missing', 'query_owner_scenario_receipt_intake_missing'];
            switch (`${domain}:${kind}`)
            {
                case 'article:latest-list':
                case 'article:category-filter':
                case 'article:tag-filter':
                    businessOwners = [article('GetPageListAsync')];
                    routePatterns = inventory.cases.filter((row) => row.kind === kind).map((row) => row.routePattern);
                    break;
                case 'article:detail':
                    businessOwners = [article('GetPublicArtifactBackedDetailAsync'), article('GetByIdAsync')];
                    routePatterns = ['/api/binary/article/{id}.aeds'];
                    break;
                case 'article:search-hit':
                case 'article:search-no-hit':
                    businessOwners = [sourceRef('src/core/Services/Abstractions/IArticleCoreService.cs',
                        'FsusBlog.Core.Services.Abstractions.IArticleCoreService.SearchArticlesAsync')];
                    routePatterns = ['/api/binary/article/search/query.aeds'];
                    blockers.push('search_ranking_role_contract_missing');
                    break;
                case 'article:top-list':
                    businessOwners = [article('GetHotArticlesAsync'), article('GetFeaturedArticlesAsync')];
                    routePatterns = ['/api/binary/admin/article/hot', '/api/binary/admin/article/featured'];
                    actorConstraint = 'AdminPermissions.ArticleWrite';
                    blockers.push('canonical_top_semantics_missing_hot_and_featured_are_distinct');
                    break;
                case 'article:prev-next':
                    businessOwners = [sourceRef('src/backend/Services/Distribution/RelatedReadingService.cs',
                        'FsusBlog.Server.Services.Distribution.RelatedReadingService.BuildFrameAsync')];
                    routePatterns = ['/api/binary/article/{articleId:int}/related.aeds'];
                    break;
                case 'article:cache-consistency':
                    businessOwners = [projectionVerifier(), article('GetPublicArtifactBackedDetailAsync'),
                        sourceRef('src/backend/Infrastructure/Cache/CachePorts.cs',
                            'FsusBlog.Server.Infrastructure.Cache.ICacheStringReader.GetStringAsync'),
                        sourceRef('src/core/Services/Gateways/IArticleCoreGateway.cs',
                            'FsusBlog.Core.Services.Gateways.IArticleCoreGateway.GetByIdAsync'),
                        sourceRef('src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs',
                            'FsusBlog.Server.Infrastructure.PublicReadArtifacts.IPublicArticleProjectionStore.TryReadAsync')];
                    routePatterns = ['/api/binary/article/{id}.aeds'];
                    blockers.push('mutation_and_cache_generation_coordinates_missing');
                    break;
                case 'article:aot-consistency':
                    businessOwners = [projectionVerifier(),
                        ...['CreateLookup', 'TryGetEntryAsync', 'IsRenderable'].map((member) =>
                            sourceRef('src/backend/Infrastructure/PublicAot/PublicAotArtifactStore.cs',
                                `FsusBlog.Server.Infrastructure.PublicAot.IPublicAotArtifactStore.${member}`)),
                        sourceRef('src/backend/Infrastructure/PublicAot/PublicAotInvalidationGenerationAuthority.cs',
                            'FsusBlog.Server.Infrastructure.PublicAot.IPublicAotInvalidationGenerationAuthority.LoadAsync'),
                        sourceRef('src/backend/Infrastructure/PublicAot/PublicAotInvalidationGenerationAuthority.cs',
                            'FsusBlog.Server.Infrastructure.PublicAot.PublicAotInvalidationGenerationState.Current'),
                        sourceRef('src/backend/Infrastructure/PublicAot/PublicRouteIdentity.cs',
                            'FsusBlog.Server.Infrastructure.PublicAot.PublicRouteIdentity.BuildCanonicalPath')];
                    routePatterns = ['/article/{articleId}'];
                    blockers.push('original_aot_artifact_and_route_identity_missing');
                    break;
                case 'article:hot-read-consistency':
                    businessOwners = [projectionVerifier(),
                        sourceRef('src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs',
                            'FsusBlog.Server.Infrastructure.PublicReadArtifacts.PublicHotReadSnapshot.TryGetArticle'),
                        sourceRef('src/backend/Infrastructure/PublicReadArtifacts/PublicArticleProjectionStore.cs',
                            'FsusBlog.Server.Infrastructure.PublicReadArtifacts.IPublicArticleProjectionStore.TryReadAsync'),
                        sourceRef('src/backend/Infrastructure/PublicReadArtifacts/ArticleDetailAedsArtifactStore.cs',
                            'FsusBlog.Server.Infrastructure.PublicReadArtifacts.IArticleDetailAedsArtifactStore.TryReadAsync'),
                        sourceRef('src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs',
                            'FsusBlog.Server.Infrastructure.PublicReadArtifacts.PublicHotReadFastPath.TryServeAsync')];
                    routePatterns = ['/api/binary/article/{id}.aeds'];
                    actorConstraint = 'PublicHotReadSecurityGateMiddleware.InvokeAsync';
                    blockers.push('original_hot_read_generation_and_residency_coordinates_missing');
                    break;
                case 'comment:public-list':
                case 'comment:pagination-order':
                    businessOwners = [comment('GetTreeRootsAsync'), comment('GetChildrenAsync')];
                    routePatterns = ['/api/binary/comment/{articleId:int}', '/api/binary/comment/{articleId:int}/children/{parentId:long}'];
                    break;
                case 'comment:public-thread':
                    businessOwners = publicCommentReads();
                    routePatterns = publicCommentRoutes();
                    blockers.push('canonical_thread_edges_and_deleted_placeholder_coordinates_missing');
                    break;
                case 'comment:deleted-root':
                    businessOwners = [comment('GetTreeRootsAsync'), comment('GetPermalinkContextAsync')];
                    routePatterns = ['/api/binary/comment/{articleId:int}', '/api/binary/comment/{articleId:int}/context/{commentId:long}'];
                    blockers.push('canonical_thread_edges_and_deleted_placeholder_coordinates_missing');
                    break;
                case 'comment:deleted-reply':
                    businessOwners = [comment('GetChildrenAsync'), comment('GetRepliesAsync'), comment('GetPermalinkContextAsync')];
                    routePatterns = publicCommentRoutes().slice(1);
                    blockers.push('canonical_thread_edges_and_deleted_placeholder_coordinates_missing');
                    break;
                case 'comment:approved-visibility':
                case 'comment:region-filter':
                    businessOwners = [...publicCommentReads(),
                        sourceRef('src/backend/Interfaces/IClientRegionResolver.cs', 'FsusBlog.Server.Interfaces.IClientRegionResolver.Resolve'),
                        sourceRef('src/backend/Interfaces/IRegionLegalModerationService.cs',
                            'FsusBlog.Server.Interfaces.IRegionLegalModerationService.NormalizeRegion')];
                    routePatterns = publicCommentRoutes();
                    blockers.push('canonical_status_region_and_publication_coordinates_missing');
                    break;
                case 'comment:moderation-queue':
                    businessOwners = [authorQueue()];
                    routePatterns = ['/api/binary/author/comments/moderation'];
                    actorConstraint = 'AdminPermissions.CommentModerate';
                    blockers.push('original_admin_actor_and_moderation_status_coordinates_missing');
                    break;
                case 'comment:pending-visibility':
                case 'comment:rejected-visibility':
                case 'comment:hidden-visibility':
                    businessOwners = [...publicCommentReads(), authorQueue(), ...actorReads(), visibilityProjection()];
                    routePatterns = [...publicCommentRoutes(), '/api/binary/author/comments/moderation', '/api/binary/comment/me'];
                    actorConstraint = 'AllowAnonymous / AdminPermissions.CommentModerate / RequireAnonymousAccountPrincipal';
                    blockers.push('canonical_actor_status_and_permission_visibility_coordinates_missing');
                    break;
                case 'comment:actor-filter':
                    businessOwners = [...actorReads(), visibilityProjection()];
                    routePatterns = ['/api/binary/comment/me'];
                    actorConstraint = 'RequireAnonymousAccountPrincipal';
                    blockers.push('canonical_actor_status_and_permission_visibility_coordinates_missing');
                    break;
                case 'comment:permission-filter':
                    businessOwners = [authorQueue()];
                    routePatterns = ['/api/binary/author/comments/moderation'];
                    actorConstraint = 'AdminPermissions.CommentModerate';
                    blockers.push('canonical_actor_status_and_permission_visibility_coordinates_missing');
                    break;
                default:
                    throw new Error(`query semantic owner is undeclared: ${domain}:${kind}`);
            }
            if (['cache-consistency', 'aot-consistency', 'hot-read-consistency'].includes(kind))
            {
                blockers.push('original_same_run_publication_receipt_and_current_invocation_missing');
            }
            const existingCaseIds = inventory.cases.filter((row) => row.domain === domain && row.kind === kind).map((row) => row.id);
            if (!existingCaseIds.length)
            {
                blockers.push('canonical_query_case_and_expected_coordinate_missing');
            }
            requirements.push({ domain, kind, existingCaseIds, businessOwners,
                routePatterns: [...new Set(routePatterns)], actorConstraint, inputs: null, canonicalRoleBindings: null,
                scenarioApplicability: null, qualification: false, releaseEvidenceEligible: false,
                status: existingCaseIds.length ? 'existing-case-mapping' : 'owner-declaration-only', blockers });
        }
    }
    const result = { schema: 'fsusblog.data-scale-query-semantic-owners.v1', binding,
        qualification: false, releaseEvidenceEligible: false, queryInventoryDigest: inventory.contentDigest,
        vocabularyDigest: computeSha256(kinds), requirements };
    return { ...result, contentDigest: computeSha256(result) };
}

export function requireQueryBinding(binding)
{
    for (const field of ['sourceCommit', 'dataScaleRunId', 'fixtureGeneration', 'seedReceiptDigest', 'expectedModelDigest', 'businessEpochUtc'])
    {
        if (typeof binding?.[field] !== 'string' || !binding[field].trim())
        {
            throw new Error(`query binding missing ${field}`);
        }
    }
    if (!/^[0-9a-f]{40}$/u.test(binding.sourceCommit)
        || !/^sha256:[0-9a-f]{64}$/u.test(binding.seedReceiptDigest)
        || !/^sha256:[0-9a-f]{64}$/u.test(binding.expectedModelDigest)
        || !/^\d{4}-\d{2}-\d{2}T.*Z$/u.test(binding.businessEpochUtc)
        || !Number.isFinite(Date.parse(binding.businessEpochUtc)))
    {
        throw new Error('query binding identity is invalid');
    }
}

export function assertSameQueryBinding(expected, actual)
{
    requireQueryBinding(expected);
    requireQueryBinding(actual);
    if (computeSha256(expected) !== computeSha256(actual))
    {
        throw new Error('query fixture generation or business epoch mismatch');
    }
}

function identifier(value)
{
    const text = String(value);
    if (!/^[1-9][0-9]*$/u.test(text))
    {
        throw new Error(`fixture ID is invalid: ${text}`);
    }
    return text;
}

function uniqueRows(rows, label)
{
    if (!Array.isArray(rows))
    {
        throw new Error(`${label} inventory missing`);
    }
    const ids = rows.map((row) => identifier(row.id));
    if (new Set(ids).size !== ids.length)
    {
        throw new Error(`${label} inventory contains duplicate IDs`);
    }
}

function idOrder(left, right)
{
    return BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0;
}

function articleOrder(left, right)
{
    const time = Date.parse(right.createTime) - Date.parse(left.createTime);
    return time || -idOrder(left, right);
}

function pageCoordinate(rows, pageSize, offset, path, requirePriorPage = false, allowEmpty = false)
{
    if ((!rows.length && !allowEmpty) || (rows.length && offset >= rows.length) || (requirePriorPage && offset < pageSize))
    {
        throw new Error('fixture has no requested nonempty cursor window');
    }
    return {
        path,
        pageSize,
        offset,
        total: rows.length,
        // The collector must traverse this exact prefix using returned cursors.
        // Page numbers alone do not advance the public article keyset path.
        traversalItems: rows,
        expectedItems: rows.slice(offset, offset + pageSize)
    };
}

/**
 * Consume the canonical expected model after IDs are mapped. Visibility is
 * supplied by that owner for the bound business epoch, never recomputed here.
 * This pure registry is not runtime admission or a qualification receipt.
 */
export function buildQueryCaseRegistry({ tier, binding, publicArticles, visibleComments, categories, tags, canaries, pageSize = 10, commentPageSize = 1,
    registrySchema = queryRegistrySchemas[0], threadReplies, relatedReading })
{
    requireQueryBinding(binding);
    queryCaseIdsForSchema(registrySchema);
    if (registrySchema === queryRegistrySchemas[0] && threadReplies !== undefined)
    {
        throw new Error('thread reply inputs require explicit v2 registry selection');
    }
    if (relatedReading !== undefined && registrySchema !== queryRegistrySchemas[2])
    {
        throw new Error('related reading inputs require explicit v3 registry selection');
    }
    if (!queryMatrixTiers.includes(tier) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
        || !Number.isSafeInteger(commentPageSize) || commentPageSize < 1 || commentPageSize > 100)
    {
        throw new Error('query tier or page size is invalid');
    }
    for (const [label, rows] of Object.entries({ publicArticles, visibleComments, categories, tags }))
    {
        uniqueRows(rows, label);
    }
    for (const row of publicArticles)
    {
        if (typeof row.title !== 'string' || !row.title || !Number.isFinite(Date.parse(row.createTime))
            || !Array.isArray(row.tagIds) || typeof row.body !== 'string')
        {
            throw new Error('canonical public article expected fields missing');
        }
        identifier(row.categoryId);
        row.tagIds.forEach(identifier);
        if (new Set(row.tagIds.map(String)).size !== row.tagIds.length)
        {
            throw new Error('canonical article has duplicate tag references');
        }
    }
    const commentsById = new Map(visibleComments.map((row) => [String(row.id), row]));
    for (const row of visibleComments)
    {
        identifier(row.articleId);
        if (row.parentId !== null)
        {
            identifier(row.parentId);
            identifier(row.rootId);
        }
        if (typeof row.content !== 'string' || !Number.isFinite(Date.parse(row.createTime)))
        {
            throw new Error('canonical visible comment expected fields missing');
        }
        if (row.parentId !== null)
        {
            const parent = commentsById.get(String(row.parentId));
            if (!parent || String(parent.articleId) !== String(row.articleId)
                || String(row.rootId) !== String(parent.rootId ?? parent.id))
            {
                throw new Error('canonical comment parent/root coordinate mismatch');
            }
        }
    }
    const articles = [...publicArticles].sort(articleOrder);
    const listItem = (row) => ({
        id: row.id,
        title: row.title,
        createTime: new Date(row.createTime).toISOString(),
        category: { id: row.categoryId, name: categories.find((item) => String(item.id) === String(row.categoryId))?.name },
        tags: row.tagIds.map((id) => ({ id, name: tags.find((item) => String(item.id) === String(id))?.name }))
    });
    const articleItems = articles.map(listItem);
    if (articleItems.some((row) => !row.category.name || row.tags.some((tag) => !tag.name)))
    {
        throw new Error('canonical article taxonomy coordinate missing');
    }
    const articlePath = `/api/binary/article/list/home/1/${pageSize}.aeds`;
    const lastOffset = (rows) => Math.max(0, Math.floor((rows.length - 1) / pageSize) * pageSize);
    const middleOffset = (rows) => Math.floor(Math.floor((rows.length - 1) / pageSize) / 2) * pageSize;
    const cases = [];
    function add(id, resolve)
    {
        try
        {
            cases.push({ id, status: 'ready', coordinate: { ...resolve(), frameType: frameTypes.get(frameName(id)) } });
        }
        catch (error)
        {
            cases.push({ id, status: 'blocked', failureReasons: [error.message] });
        }
    }
    add('article-list-first-page', () => pageCoordinate(articleItems, pageSize, 0, articlePath));
    add('article-list-middle-page', () => pageCoordinate(articleItems, pageSize, middleOffset(articles), articlePath, true));
    add('article-list-last-page', () => pageCoordinate(articleItems, pageSize, lastOffset(articles), articlePath));
    add('article-list-deep-cursor', () => pageCoordinate(articleItems, pageSize, lastOffset(articles), articlePath, true));

    const commentArticleId = canaries?.commentArticleId;
    const roots = visibleComments.filter((row) => String(row.articleId) === String(commentArticleId) && row.parentId === null)
        .sort((left, right) => -idOrder(left, right));
    const childrenByParent = new Map();
    for (const row of visibleComments)
    {
        if (row.parentId !== null && String(row.articleId) === String(commentArticleId))
        {
            const key = String(row.parentId);
            const children = childrenByParent.get(key) ?? [];
            children.push(row);
            childrenByParent.set(key, children);
        }
    }
    const commentItem = (row) => ({ id: String(row.id), content: row.content, createTime: new Date(row.createTime).toISOString(),
        rootId: String(row.rootId ?? row.id), parentId: row.parentId === null ? null : String(row.parentId) });
    const rootItems = roots.map((row) => ({ ...commentItem(row),
        childrenPreview: [...(childrenByParent.get(String(row.id)) ?? [])].sort(idOrder).slice(0, 3).map(commentItem) }));
    const rootPath = `/api/binary/comment/${commentArticleId}?limit=${commentPageSize}`;
    add('comment-root-first', () =>
    {
        if (!articles.some((row) => String(row.id) === identifier(commentArticleId)))
        {
            throw new Error('exact comment article coordinate missing');
        }
        return pageCoordinate(rootItems, commentPageSize, 0, rootPath, false, true);
    });
    const commentLastOffset = Math.max(0, Math.floor((roots.length - 1) / commentPageSize) * commentPageSize);
    const commentMiddleOffset = Math.floor(Math.floor((roots.length - 1) / commentPageSize) / 2) * commentPageSize;
    add('comment-root-middle-cursor', () => pageCoordinate(rootItems, commentPageSize, commentMiddleOffset, rootPath, true));
    add('comment-root-last-cursor', () => pageCoordinate(rootItems, commentPageSize, commentLastOffset, rootPath, true));
    add('comment-nested-root-expansion', () =>
    {
        const rootId = identifier(canaries?.nestedRootId);
        if (!roots.some((root) => String(root.id) === rootId))
        {
            throw new Error('exact nested root canary missing');
        }
        const children = visibleComments.filter((row) => String(row.articleId) === String(commentArticleId) && String(row.parentId) === rootId)
            .sort(idOrder);
        const childItems = children.map((row) => ({ id: String(row.id), content: row.content, createTime: new Date(row.createTime).toISOString(), rootId, parentId: rootId }));
        return { ...pageCoordinate(childItems, commentPageSize, 0, `/api/binary/comment/${commentArticleId}/children/${rootId}?limit=${commentPageSize}`), rootId };
    });

    function taxonomyCoordinate(rows, type, empty)
    {
        const counted = rows.map((row) => ({
            ...row,
            articles: articles.filter((article) => type === 'category'
                ? String(article.categoryId) === String(row.id)
                : article.tagIds.some((id) => String(id) === String(row.id)))
        })).sort((left, right) => right.articles.length - left.articles.length || idOrder(left, right));
        const row = empty ? counted.find((item) => item.articles.length === 0) : counted[0];
        if (!row || (!empty && row.articles.length === 0) || typeof row.name !== 'string' || !row.name)
        {
            throw new Error(`fixture has no ${empty ? 'empty' : 'nonempty largest'} ${type}`);
        }
        return {
            ...pageCoordinate(row.articles.map(listItem), pageSize, 0, `/api/binary/article/list/${type}/${row.id}/1/${pageSize}.aeds`, false, empty),
            taxonomyId: identifier(row.id),
            taxonomyName: row.name,
            articleIds: row.articles.map((article) => article.id)
        };
    }
    for (const type of ['category', 'tag'])
    {
        add(`${type}-largest`, () => taxonomyCoordinate(type === 'category' ? categories : tags, type, false));
        add(`${type}-empty`, () => taxonomyCoordinate(type === 'category' ? categories : tags, type, true));
    }
    for (const [id, article] of [['article-detail-first', articles[0]], ['article-detail-last', articles.at(-1)]])
    {
        add(id, () =>
        {
            if (!article)
            {
                throw new Error('fixture public detail coordinate missing');
            }
            return { path: `/api/binary/article/${article.id}.aeds`, expectedItems: [{ ...listItem(article), content: article.body }] };
        });
    }
    for (const [id, canary] of [['search-title-canary', canaries?.titleSearch], ['search-body-canary', canaries?.bodySearch]])
    {
        add(id, () =>
        {
            if (typeof canary?.token !== 'string' || !canary.token || !Array.isArray(canary.articleIds) || !canary.articleIds.length)
            {
                throw new Error('exact search canary coordinate missing');
            }
            const expectedItems = canary.articleIds.map((articleId) =>
            {
                const article = articles.find((row) => String(row.id) === identifier(articleId));
                if (!article)
                {
                    throw new Error('search canary references nonpublic fixture article');
                }
                return listItem(article);
            });
            uniqueRows(expectedItems, 'search canary');
            return { path: `/api/binary/article/search/query.aeds?q=${encodeURIComponent(canary.token)}`, token: canary.token, expectedItems };
        });
    }
    if (registrySchema !== queryRegistrySchemas[0])
    {
        add(threadReplyCaseId, () => threadReplyCoordinate(threadReplies));
        const entry = cases.at(-1);
        entry.status = 'blocked';
        entry.failureReasons = [...(entry.failureReasons ?? []), ...queryExecutionBlockers(threadReplyCaseId)];
    }
    if (registrySchema === queryRegistrySchemas[2])
    {
        add(relatedReadingCaseId, () => relatedReadingCoordinate(relatedReading));
        const entry = cases.at(-1);
        entry.status = 'blocked';
        entry.failureReasons = [...(entry.failureReasons ?? []), ...queryExecutionBlockers(relatedReadingCaseId)];
    }
    const result = { schema: registrySchema, tier, binding, cases, inventory: buildQueryCaseInventory(binding, registrySchema) };
    return { ...result, contentDigest: computeSha256(result) };
}

/** Related and neighboring roles may legitimately reference the same native article. */
function relatedReadingCoordinate(input)
{
    if (!input || !Number.isInteger(input.articleId) || input.articleId < 1 || input.articleId > 2147483647
        || !Array.isArray(input.related) || input.related.length > 6 || input.previous === undefined || input.next === undefined)
    {
        throw new Error('typed related reading article/related/previous/next inputs missing');
    }
    const item = (row) =>
    {
        if (!row || !Number.isInteger(row.id) || row.id < 1 || row.id > 2147483647 || row.id === input.articleId
            || typeof row.title !== 'string' || typeof row.reason !== 'string'
            || !(row.summary === null || typeof row.summary === 'string') || !Number.isFinite(Date.parse(row.createTime)))
        {
            throw new Error('typed related reading item fields invalid');
        }
        return { id: row.id, title: row.title, summary: row.summary,
            createTime: new Date(row.createTime).toISOString(), reason: row.reason };
    };
    const related = input.related.map(item);
    uniqueRows(related, 'explicit related reading list');
    const previous = input.previous === null ? null : item(input.previous);
    const next = input.next === null ? null : item(input.next);
    if (previous && next && previous.id === next.id)
    {
        throw new Error('previous and next must be distinct article coordinates');
    }
    return { path: `/api/binary/article/${input.articleId}/related.aeds`, expectedItems: [],
        expectedPayloadProjection: { related, previous, next } };
}

/** Explicit probe coordinates are structural inputs, never qualified producer roles or revision authority. */
function threadReplyCoordinate(input)
{
    if (!input || !Number.isInteger(input.articleId) || input.articleId < 1 || input.articleId > 2147483647
        || typeof input.rootId !== 'string' || !/^[1-9][0-9]*$/u.test(input.rootId) || BigInt(input.rootId) > 9223372036854775807n
        || !Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100 || !Array.isArray(input.expectedReplies))
    {
        throw new Error('typed thread reply article/root/page/expected inputs missing or invalid');
    }
    uniqueRows(input.expectedReplies, 'explicit thread reply projection');
    const fields = ['id', 'content', 'createTime', 'rootId', 'parentId', 'depth', 'isDeleted', 'isEdited'];
    const rows = input.expectedReplies.map((row, index) =>
    {
        if (typeof row.id !== 'string' || !/^[1-9][0-9]*$/u.test(row.id) || BigInt(row.id) > 9223372036854775807n
            || row.id === input.rootId || row.rootId !== input.rootId || typeof row.parentId !== 'string'
            || !/^[1-9][0-9]*$/u.test(row.parentId) || BigInt(row.parentId) > 9223372036854775807n || row.parentId === row.id
            || typeof row.content !== 'string' || !Number.isFinite(Date.parse(row.createTime))
            || !Number.isInteger(row.depth) || row.depth < 1 || typeof row.isDeleted !== 'boolean' || typeof row.isEdited !== 'boolean'
            || (index > 0 && BigInt(input.expectedReplies[index - 1].id) >= BigInt(row.id)))
        {
            throw new Error('explicit thread reply projected membership/order/edge fields invalid');
        }
        return Object.fromEntries(fields.map((field) => [field, field === 'createTime' ? new Date(row[field]).toISOString() : row[field]]));
    });
    return { ...pageCoordinate(rows, input.pageSize, 0,
        `/api/binary/comment/${input.articleId}/thread/${input.rootId}?limit=${input.pageSize}`, false, true),
    threadRootId: input.rootId, cursorKind: 'int64-last-item' };
}
