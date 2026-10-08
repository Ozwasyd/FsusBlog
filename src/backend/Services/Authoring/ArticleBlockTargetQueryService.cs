using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Sole article/heading target-page algorithm over the existing DTOs and actual relation index.
/// Independent observed authority revisions surround every read; index inspection never mints them.
/// Runtime permission admission requires a real canonical source adapter, not a fixture or a sealed DTO.
/// The service registers no transport, persistence, parser, source writer or second relation index.
/// </summary>
public sealed class ArticleBlockTargetQueryService(ArticleRelationIndex index, IArticleBlockTargetQuerySource source)
{
    public const int MaximumSourcePageSize = BlockTargetQuerySchemas.MaximumPageSize + 1;

    /// <summary>Returns a bounded existing article page after original source and authority revalidation.</summary>
    public async Task<BlockTargetArticleQueryPage> QueryArticlesAsync(
        BlockTargetQueryRequest request,
        BlockTargetQueryCursor? cursor = null,
        CancellationToken cancellationToken = default)
    {
        ValidateRequest(request, cursor, BlockTargetQueryLayer.Articles);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleBlockTargetQueryObservation? observation = await ObserveAsync(request, cancellationToken).ConfigureAwait(false);
            Require(observation is not null, "article_target_query_authority_unavailable");
            ArticleBlockTargetQueryArticleBatch batch = await source.ReadArticlesAsync(
                observation!, request.Search, cursor?.Continuation, request.Limit + 1, cancellationToken).ConfigureAwait(false);
            Require(batch.Observation == observation && !batch.Items.IsDefault && batch.Items.Length <= request.Limit + 1,
                "article_target_query_source_binding_invalid");
            ImmutableArray<BlockTargetArticleQueryItem> candidates = batch.Items;
            string? previous = cursor?.Continuation;
            foreach (BlockTargetArticleQueryItem item in candidates)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Require(item is not null && IsBoundedArticle(item.Article) && item.Title is { Length: > 0 and <= 256 }
                    && BlockTargetQueryValidator.Validate(ArticlePage(request, BlockTargetQueryPageStatus.Ready, [item]), request).IsValid
                    && IsScopeCandidate(item.Article, request.Scope)
                    && (previous is null || StringComparer.Ordinal.Compare(item.Article.ArticleIdentity, previous) > 0)
                    && item.Title.Contains(request.Search, StringComparison.OrdinalIgnoreCase), "article_target_query_candidate_invalid");
                RequireIndexedArticle(item.Article, observation!);
                previous = item.Article.ArticleIdentity;
            }
            ImmutableArray<BlockTargetArticleQueryItem> items = candidates.Take(request.Limit).ToImmutableArray();
            foreach (BlockTargetArticleQueryItem item in items)
            {
                await RevalidateTargetAsync(item.Article.ArticleIdentity, null, observation!, cancellationToken).ConfigureAwait(false);
            }
            await ReobserveAsync(request, observation!, cancellationToken).ConfigureAwait(false);
            BlockTargetQueryCursor? next = candidates.Length > request.Limit
                ? Cursor(request, items[^1].Article.ArticleIdentity) : null;
            BlockTargetArticleQueryPage page = ArticlePage(request, BlockTargetQueryPageStatus.Ready, items, next);
            Require(BlockTargetQueryValidator.Validate(page, request).IsValid, "article_target_query_page_invalid");
            return page;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return ArticlePage(request, BlockTargetQueryPageStatus.Cancelled, []);
        }
        catch (Exception)
        {
            return ArticlePage(request, BlockTargetQueryPageStatus.Unavailable, []);
        }
    }

    /// <summary>Authorizes the exact selected article before reading canonical paged heading inventory.</summary>
    public async Task<BlockTargetHeadingQueryPage> QueryHeadingsAsync(
        BlockTargetQueryRequest request,
        BlockTargetQueryCursor? cursor = null,
        CancellationToken cancellationToken = default)
    {
        ValidateRequest(request, cursor, BlockTargetQueryLayer.Headings);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleBlockTargetQueryObservation? observation = await ObserveAsync(request, cancellationToken).ConfigureAwait(false);
            Require(observation is not null, "heading_target_query_authority_unavailable");
            ArticleBlockTargetQueryArticleRead article = await source.ReadArticleAsync(
                observation!, request.Article!.ArticleIdentity, cancellationToken).ConfigureAwait(false);
            Require(article.Observation == observation && article.Item?.Article == request.Article
                && article.Item.Title is { Length: > 0 and <= 256 }
                && IsScopeCandidate(request.Article, request.Scope)
                && BlockTargetQueryValidator.Validate(ArticlePage(ArticleRequest(request), BlockTargetQueryPageStatus.Ready,
                    [article.Item!]), ArticleRequest(request)).IsValid, "heading_target_query_article_unavailable");
            RequireIndexedArticle(request.Article, observation!);
            ArticleBlockTargetQueryHeadingBatch batch = await source.ReadHeadingsAsync(
                observation!, request.Article, request.Search, cursor?.Continuation, request.Limit + 1, cancellationToken).ConfigureAwait(false);
            Require(batch.Observation == observation && batch.Article == request.Article && Enum.IsDefined(batch.Diagnostic)
                && batch.SourceUtf16Length is >= 0 and <= ArticleRelationIndex.MaxStoredTextCharacters
                && !batch.Items.IsDefault && batch.Items.Length <= request.Limit + 1, "heading_target_query_source_binding_invalid");
            if (batch.Diagnostic != BlockTargetInventoryDiagnostic.None)
            {
                Require(batch.Items.IsEmpty, "heading_target_query_blocked_content_invalid");
                await RevalidateTargetAsync(request.Article.ArticleIdentity, null, observation!, cancellationToken).ConfigureAwait(false);
                await ReobserveAsync(request, observation!, cancellationToken).ConfigureAwait(false);
                return HeadingPage(request, BlockTargetQueryPageStatus.Blocked, [], batch.Diagnostic);
            }
            string? previous = cursor?.Continuation;
            foreach (BlockTargetHeadingQueryItem item in batch.Items)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Require(item is not null && item.Article == request.Article && item.DisplayText is { Length: > 0 and <= 256 }
                    && item.SourceNodeIdentity is { Length: > 0 and <= 256 }
                    && ArticleEmbedTargetCodec.IsCanonicalHeadingIdentity(item.HeadingIdentity)
                    && BlockTargetQueryValidator.Validate(HeadingPage(request, BlockTargetQueryPageStatus.Ready, [item]), request).IsValid
                    && item.SourceEnd <= batch.SourceUtf16Length
                    && (previous is null || StringComparer.Ordinal.Compare(item.HeadingIdentity, previous) > 0)
                    && item.DisplayText.Contains(request.Search, StringComparison.OrdinalIgnoreCase), "heading_target_query_candidate_invalid");
                previous = item.HeadingIdentity;
            }
            ImmutableArray<BlockTargetHeadingQueryItem> items = batch.Items.Take(request.Limit).ToImmutableArray();
            await RevalidateTargetAsync(request.Article.ArticleIdentity, null, observation!, cancellationToken).ConfigureAwait(false);
            foreach (BlockTargetHeadingQueryItem item in items)
            {
                await RevalidateTargetAsync(item.Article.ArticleIdentity, item.HeadingIdentity, observation!, cancellationToken).ConfigureAwait(false);
            }
            await ReobserveAsync(request, observation!, cancellationToken).ConfigureAwait(false);
            BlockTargetQueryCursor? next = batch.Items.Length > request.Limit ? Cursor(request, items[^1].HeadingIdentity) : null;
            BlockTargetHeadingQueryPage page = HeadingPage(request, BlockTargetQueryPageStatus.Ready, items, next: next);
            Require(BlockTargetQueryValidator.Validate(page, request).IsValid, "heading_target_query_page_invalid");
            return page;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return HeadingPage(request, BlockTargetQueryPageStatus.Cancelled, []);
        }
        catch (Exception)
        {
            return HeadingPage(request, BlockTargetQueryPageStatus.Unavailable, []);
        }
    }

    private async Task<ArticleBlockTargetQueryObservation?> ObserveAsync(BlockTargetQueryRequest request, CancellationToken cancellationToken)
    {
        var actor = new ArticleRelationActorContext(request.Coordinate.ActorIdentity, request.Coordinate.SiteIdentity,
            request.Coordinate.PermissionContextDigest);
        ArticleBlockTargetQueryObservation? observation = await source.ObserveAsync(actor, request.Scope, cancellationToken).ConfigureAwait(false);
        Require(observation is null || observation.Coordinate == request.Coordinate && observation.Scope == request.Scope
            && observation.SourceGeneration > 0 && observation.IndexGeneration > 0, "article_target_query_revision_stale");
        if (observation is not null)
        {
            ArticleRelationIndexSnapshot snapshot = index.ReadSnapshot(observation.IndexGeneration);
            Require(snapshot.Actor == actor && snapshot.SourceGeneration == observation.SourceGeneration,
                "article_target_query_index_binding_invalid");
        }
        return observation;
    }

    private async Task ReobserveAsync(BlockTargetQueryRequest request, ArticleBlockTargetQueryObservation observation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(await ObserveAsync(request, cancellationToken).ConfigureAwait(false) == observation,
            "article_target_query_observation_stale");
        cancellationToken.ThrowIfCancellationRequested();
    }

    private void RequireIndexedArticle(BlockTargetArticleCoordinate article, ArticleBlockTargetQueryObservation observation)
    {
        ArticleRelationIndexSnapshot snapshot = index.ReadSnapshot(observation.IndexGeneration);
        Require(snapshot.Articles.TryGetValue(article.ArticleIdentity, out ArticleRelationIndexArticle? family)
            && family.Sets.Any(set => set.Source.RevisionIdentity == article.RevisionIdentity
                && set.Source.RevisionNumber == article.RevisionNumber && set.Source.RevisionKind == article.RevisionKind
                && set.Source.Lifecycle == article.Lifecycle && set.Source.ContentDigest == article.ContentDigest),
            "article_target_query_source_revision_stale");
    }

    private async Task RevalidateTargetAsync(string articleIdentity, string? headingIdentity,
        ArticleBlockTargetQueryObservation observation, CancellationToken cancellationToken)
    {
        var target = new ArticleRelationTargetIdentity(articleIdentity,
            headingIdentity is null ? ArticleRelationTargetKind.Article : ArticleRelationTargetKind.Heading, headingIdentity, null);
        ArticleRelationIndexInspection inspection = index.InspectTarget(target, observation.IndexGeneration, cancellationToken: cancellationToken);
        Require(inspection.SourceGeneration == observation.SourceGeneration, "article_target_query_index_source_stale");
        await index.RevalidateSourceAsync(inspection, cancellationToken).ConfigureAwait(false);
    }

    private static void ValidateRequest(BlockTargetQueryRequest request, BlockTargetQueryCursor? cursor, BlockTargetQueryLayer layer)
    {
        Require(BlockTargetQueryValidator.Validate(request).IsValid && request.Layer == layer
            && (cursor is null || BlockTargetQueryValidator.Validate(cursor, request).IsValid
                && (layer == BlockTargetQueryLayer.Articles
                    ? BlockAnchorContractValidator.IsStableArticleIdentity(cursor.Continuation)
                    : ArticleEmbedTargetCodec.IsCanonicalHeadingIdentity(cursor.Continuation))), "article_target_query_request_invalid");
    }

    private static BlockTargetQueryRequest ArticleRequest(BlockTargetQueryRequest request)
    {
        BlockTargetQueryRequest article = request with
        {
            Layer = BlockTargetQueryLayer.Articles,
            Article = null,
            RequestDigest = string.Empty
        };
        return article with
        {
            RequestDigest = BlockTargetQueryDigest.ComputeRequest(article)
        };
    }

    private static bool IsScopeCandidate(BlockTargetArticleCoordinate article, BlockTargetQueryScope scope)
        => scope != BlockTargetQueryScope.CurrentPublicPublication || article.Lifecycle == ArticleRelationLifecycleState.Published;

    private static bool IsBoundedArticle(BlockTargetArticleCoordinate? article)
        => article is not null && BlockAnchorContractValidator.IsStableArticleIdentity(article.ArticleIdentity)
            && article.RevisionIdentity is { Length: > 0 and <= 256 }
            && BlockAnchorContractValidator.IsCanonicalSlug(article.CanonicalSlug)
            && BlockAnchorContractDigest.IsSha256(article.ContentDigest);

    private static BlockTargetQueryCursor Cursor(BlockTargetQueryRequest request, string continuation)
    {
        var cursor = new BlockTargetQueryCursor(BlockTargetQuerySchemas.Cursor,
            BlockTargetQuerySchemas.Version, request.RequestDigest, continuation, string.Empty);
        return cursor with
        {
            CursorDigest = BlockTargetQueryDigest.ComputeCursor(cursor)
        };
    }

    private static BlockTargetArticleQueryPage ArticlePage(BlockTargetQueryRequest request, BlockTargetQueryPageStatus status,
        IReadOnlyList<BlockTargetArticleQueryItem> items, BlockTargetQueryCursor? next = null)
    {
        var page = new BlockTargetArticleQueryPage(BlockTargetQuerySchemas.ArticlePage,
            BlockTargetQuerySchemas.Version, request.RequestDigest, status, items, next, string.Empty);
        return page with
        {
            PageDigest = BlockTargetQueryDigest.ComputePage(page)
        };
    }

    private static BlockTargetHeadingQueryPage HeadingPage(BlockTargetQueryRequest request, BlockTargetQueryPageStatus status,
        IReadOnlyList<BlockTargetHeadingQueryItem> items, BlockTargetInventoryDiagnostic diagnostic = BlockTargetInventoryDiagnostic.None,
        BlockTargetQueryCursor? next = null)
    {
        var page = new BlockTargetHeadingQueryPage(BlockTargetQuerySchemas.HeadingPage,
            BlockTargetQuerySchemas.Version, request.RequestDigest, status, diagnostic, items, next, string.Empty);
        return page with
        {
            PageDigest = BlockTargetQueryDigest.ComputePage(page)
        };
    }

    private static void Require([DoesNotReturnIf(false)] bool condition, string reasonCode)
    {
        if (!condition)
        {
            throw new ArticleRelationIndexException(reasonCode);
        }
    }
}
