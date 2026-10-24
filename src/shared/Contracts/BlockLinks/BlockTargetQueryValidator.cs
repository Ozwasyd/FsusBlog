using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>
/// Validates bounded structural contracts against independently supplied current coordinates.
/// Callers must first enforce server permissions and canonical inventory diagnostics; a valid
/// digest proves consistency only and does not prove parser provenance or authority.
/// </summary>
public static class BlockTargetQueryValidator
{
    public static BlockTargetQueryValidationResult Validate(BlockTargetQueryRequest? request)
    {
        if (request is null
            || request.Schema != BlockTargetQuerySchemas.Request
            || request.SchemaVersion != BlockTargetQuerySchemas.Version
            || !IsCoordinate(request.Coordinate)
            || !Enum.IsDefined(request.Layer)
            || !Enum.IsDefined(request.Scope)
            || !IsText(request.Search, BlockTargetQuerySchemas.MaximumSearchLength, true)
            || request.Limit is < 1 or > BlockTargetQuerySchemas.MaximumPageSize
            || request.RequestSequence < 1
            || request.Layer == BlockTargetQueryLayer.Articles && request.Article is not null
            || request.Layer != BlockTargetQueryLayer.Articles && !IsArticle(request.Article, request.Scope)
            || !BlockAnchorContractDigest.IsSha256(request.RequestDigest))
        {
            return BlockTargetQueryValidationResult.Invalid("block_target_request_invalid");
        }

        return request.RequestDigest == BlockTargetQueryDigest.ComputeRequest(request)
            ? BlockTargetQueryValidationResult.Valid()
            : BlockTargetQueryValidationResult.Invalid("block_target_request_digest_mismatch");
    }

    public static BlockTargetQueryValidationResult Validate(
        BlockTargetQueryCursor? cursor,
        BlockTargetQueryRequest? currentRequest)
    {
        if (!Validate(currentRequest).IsValid
            || cursor is null
            || cursor.Schema != BlockTargetQuerySchemas.Cursor
            || cursor.SchemaVersion != BlockTargetQuerySchemas.Version
            || !IsText(cursor.Continuation, 256, false)
            || !BlockAnchorContractDigest.IsSha256(cursor.CursorDigest))
        {
            return BlockTargetQueryValidationResult.Invalid("block_target_cursor_invalid");
        }

        if (cursor.RequestDigest != currentRequest!.RequestDigest)
        {
            return BlockTargetQueryValidationResult.Invalid("block_target_cursor_stale");
        }

        return cursor.CursorDigest == BlockTargetQueryDigest.ComputeCursor(cursor)
            ? BlockTargetQueryValidationResult.Valid()
            : BlockTargetQueryValidationResult.Invalid("block_target_cursor_digest_mismatch");
    }

    public static BlockTargetQueryValidationResult Validate(
        BlockTargetQueryToken? token,
        BlockTargetQueryRequest? currentRequest)
    {
        if (!Validate(currentRequest).IsValid
            || currentRequest!.Layer != BlockTargetQueryLayer.Blocks
            || token is null
            || token.Schema != BlockTargetQuerySchemas.Token
            || token.SchemaVersion != BlockTargetQuerySchemas.Version
            || !BlockAnchorContractValidator.Validate(token.Target).IsValid
            || !IsArticle(token.Article, currentRequest.Scope)
            || !IsSelectableArticle(token.Article, currentRequest.Scope)
            || token.Target.ArticleIdentity != token.Article.ArticleIdentity
            || !IsText(token.SourceNodeIdentity, 256, false)
            || token.SourceStart < 0
            || token.SourceEnd <= token.SourceStart
            || !IsText(token.BlockKind, 64, false)
            || !IsText(token.ContextSnippet, BlockTargetQuerySchemas.MaximumSnippetLength, true)
            || !BlockAnchorContractValidator.IsCanonicalSlug(token.CanonicalSlug)
            || token.CanonicalSlug != token.Article.CanonicalSlug
            || !BlockAnchorContractDigest.IsSha256(token.TokenDigest))
        {
            return BlockTargetQueryValidationResult.Invalid("block_target_token_invalid");
        }

        if (token.RequestDigest != currentRequest.RequestDigest || token.Article != currentRequest.Article)
        {
            return BlockTargetQueryValidationResult.Invalid("block_target_token_stale");
        }

        return token.TokenDigest == BlockTargetQueryDigest.ComputeToken(token)
            ? BlockTargetQueryValidationResult.Valid()
            : BlockTargetQueryValidationResult.Invalid("block_target_token_digest_mismatch");
    }

    public static BlockTargetQueryValidationResult Validate(
        BlockTargetQueryPage? page,
        BlockTargetQueryRequest? currentRequest)
    {
        if (!Validate(currentRequest).IsValid
            || currentRequest!.Layer != BlockTargetQueryLayer.Blocks
            || page is null
            || page.Schema != BlockTargetQuerySchemas.Page
            || page.SchemaVersion != BlockTargetQuerySchemas.Version
            || !Enum.IsDefined(page.Status)
            || !Enum.IsDefined(page.Diagnostic)
            || page.Items is null
            || page.Items.Count > currentRequest.Limit
            || page.RequestDigest != currentRequest.RequestDigest
            || !BlockAnchorContractDigest.IsSha256(page.PageDigest))
        {
            return BlockTargetQueryValidationResult.Invalid("block_target_page_invalid");
        }

        if (page.Status is BlockTargetQueryPageStatus.Ready or BlockTargetQueryPageStatus.Blocked
            && !IsSelectableArticle(currentRequest.Article!, currentRequest.Scope))
        {
            return BlockTargetQueryValidationResult.Invalid("block_target_page_disclosure_invalid");
        }

        if (page.Status != BlockTargetQueryPageStatus.Ready)
        {
            if (page.Items.Count != 0
                || page.Next is not null
                || (page.Status == BlockTargetQueryPageStatus.Blocked
                    ? page.Diagnostic == BlockTargetInventoryDiagnostic.None
                    : page.Diagnostic != BlockTargetInventoryDiagnostic.None))
            {
                return BlockTargetQueryValidationResult.Invalid("block_target_page_disclosure_invalid");
            }
        }
        else
        {
            if (page.Diagnostic != BlockTargetInventoryDiagnostic.None
                || page.Next is not null && (page.Items.Count == 0 || !Validate(page.Next, currentRequest).IsValid))
            {
                return BlockTargetQueryValidationResult.Invalid("block_target_page_diagnostic_invalid");
            }

            var anchors = new HashSet<BlockAnchorId>();
            foreach (BlockTargetQueryToken token in page.Items)
            {
                if (!Validate(token, currentRequest).IsValid || !anchors.Add(token.Target.AnchorId))
                {
                    return BlockTargetQueryValidationResult.Invalid("block_target_page_item_invalid");
                }
            }
        }

        return page.PageDigest == BlockTargetQueryDigest.ComputePage(page)
            ? BlockTargetQueryValidationResult.Valid()
            : BlockTargetQueryValidationResult.Invalid("block_target_page_digest_mismatch");
    }

    public static BlockTargetQueryValidationResult Validate(
        BlockTargetArticleQueryPage? page,
        BlockTargetQueryRequest? currentRequest)
    {
        if (!Validate(currentRequest).IsValid
            || currentRequest!.Layer != BlockTargetQueryLayer.Articles
            || page is null
            || page.Schema != BlockTargetQuerySchemas.ArticlePage
            || page.SchemaVersion != BlockTargetQuerySchemas.Version
            || !Enum.IsDefined(page.Status)
            || page.Status == BlockTargetQueryPageStatus.Blocked
            || page.Items is null
            || page.Items.Count > currentRequest.Limit
            || page.RequestDigest != currentRequest.RequestDigest
            || !BlockAnchorContractDigest.IsSha256(page.PageDigest)
            || !IsPageContentShape(page.Status, page.Items.Count, page.Next, currentRequest))
        {
            return BlockTargetQueryValidationResult.Invalid("article_target_page_invalid");
        }

        var articles = new HashSet<string>(StringComparer.Ordinal);
        foreach (BlockTargetArticleQueryItem item in page.Items)
        {
            if (item is null
                || !IsArticle(item.Article, currentRequest.Scope)
                || !IsSelectableArticle(item.Article, currentRequest.Scope)
                || !IsText(item.Title, 256, false)
                || item.UpdatedAtUnixMilliseconds < 0
                || !articles.Add(item.Article.ArticleIdentity))
            {
                return BlockTargetQueryValidationResult.Invalid("article_target_page_item_invalid");
            }
        }

        return page.PageDigest == BlockTargetQueryDigest.ComputePage(page)
            ? BlockTargetQueryValidationResult.Valid()
            : BlockTargetQueryValidationResult.Invalid("article_target_page_digest_mismatch");
    }

    public static BlockTargetQueryValidationResult Validate(
        BlockTargetHeadingQueryPage? page,
        BlockTargetQueryRequest? currentRequest)
    {
        if (!Validate(currentRequest).IsValid
            || currentRequest!.Layer != BlockTargetQueryLayer.Headings
            || page is null
            || page.Schema != BlockTargetQuerySchemas.HeadingPage
            || page.SchemaVersion != BlockTargetQuerySchemas.Version
            || !Enum.IsDefined(page.Status)
            || !Enum.IsDefined(page.Diagnostic)
            || page.Items is null
            || page.Items.Count > currentRequest.Limit
            || page.RequestDigest != currentRequest.RequestDigest
            || !BlockAnchorContractDigest.IsSha256(page.PageDigest)
            || !IsPageContentShape(page.Status, page.Items.Count, page.Next, currentRequest)
            || (page.Status == BlockTargetQueryPageStatus.Blocked
                ? page.Diagnostic == BlockTargetInventoryDiagnostic.None
                : page.Diagnostic != BlockTargetInventoryDiagnostic.None)
            || page.Status is BlockTargetQueryPageStatus.Ready or BlockTargetQueryPageStatus.Blocked
                && !IsSelectableArticle(currentRequest.Article!, currentRequest.Scope))
        {
            return BlockTargetQueryValidationResult.Invalid("heading_target_page_invalid");
        }

        var headings = new HashSet<string>(StringComparer.Ordinal);
        foreach (BlockTargetHeadingQueryItem item in page.Items)
        {
            if (item is null
                || item.Article != currentRequest.Article
                || !ArticleEmbedTargetCodec.IsCanonicalHeadingIdentity(item.HeadingIdentity)
                || !IsText(item.SourceNodeIdentity, 256, false)
                || item.SourceStart < 0
                || item.SourceEnd <= item.SourceStart
                || !IsText(item.DisplayText, 256, false)
                || !headings.Add(item.HeadingIdentity))
            {
                return BlockTargetQueryValidationResult.Invalid("heading_target_page_item_invalid");
            }
        }

        return page.PageDigest == BlockTargetQueryDigest.ComputePage(page)
            ? BlockTargetQueryValidationResult.Valid()
            : BlockTargetQueryValidationResult.Invalid("heading_target_page_digest_mismatch");
    }

    private static bool IsPageContentShape(
        BlockTargetQueryPageStatus status,
        int itemCount,
        BlockTargetQueryCursor? next,
        BlockTargetQueryRequest request)
        => status == BlockTargetQueryPageStatus.Ready
            ? next is null || itemCount > 0 && Validate(next, request).IsValid
            : itemCount == 0 && next is null;

    private static bool IsCoordinate(BlockTargetQueryCoordinate? coordinate)
        => coordinate is not null
            && ArticleRelationContractValidator.Validate(new ArticleRelationActorContext(
                coordinate.ActorIdentity, coordinate.SiteIdentity, coordinate.PermissionContextDigest)).IsValid
            && coordinate.PermissionRevision > 0
            && coordinate.QueryRevision > 0
            && coordinate.IndexRevision > 0
            && coordinate.RouteRevision > 0
            && coordinate.AnchorContractVersion == BlockAnchorSchemas.Version
            && coordinate.AnchorContractDigest == BlockAnchorSchemas.ContractDigest;

    private static bool IsArticle(BlockTargetArticleCoordinate? article, BlockTargetQueryScope scope)
        => article is not null
            && BlockAnchorContractValidator.IsStableArticleIdentity(article.ArticleIdentity)
            && ArticleRelationContractValidator.Validate(new ArticleRelationTargetFacts(
                new ArticleRelationTargetIdentity(article.ArticleIdentity, ArticleRelationTargetKind.Article, null, null),
                article.RevisionIdentity, article.RevisionNumber, article.RevisionKind,
                article.Lifecycle, article.Permission)).IsValid
            && BlockAnchorContractDigest.IsSha256(article.ContentDigest)
            && BlockAnchorContractValidator.IsCanonicalSlug(article.CanonicalSlug)
            && Enum.IsDefined(article.EditPermission)
            && (scope == BlockTargetQueryScope.AuthoringCurrent
                ? article.RevisionKind is ArticleRelationRevisionKind.Draft or ArticleRelationRevisionKind.Current
                : article.RevisionKind == ArticleRelationRevisionKind.Published);

    private static bool IsSelectableArticle(BlockTargetArticleCoordinate article, BlockTargetQueryScope scope)
        => article.Permission == ArticleRelationPermissionState.Allowed
            && (scope != BlockTargetQueryScope.AuthoringCurrent
                || article.EditPermission == ArticleRelationPermissionState.Allowed)
            && article.Lifecycle is not ArticleRelationLifecycleState.Archived and not ArticleRelationLifecycleState.Deleted;

    private static bool IsText(string? value, int maximumLength, bool allowEmpty)
        => value is not null
            && value.Length <= maximumLength
            && (allowEmpty || value.Length > 0)
            && !value.Any(char.IsControl);
}
