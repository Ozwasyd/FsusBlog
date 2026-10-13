using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Original independently observed permission/query/index/route revisions and source/index leases.
/// No revision may be copied from a client request or inferred from an index inspection. The producer
/// adapter must bind the actual authenticated actor, site and current source authorities.
/// </summary>
public sealed record ArticleBlockTargetQueryObservation(
    BlockTargetQueryCoordinate Coordinate,
    BlockTargetQueryScope Scope,
    long SourceGeneration,
    long IndexGeneration);

/// <summary>Permission-filtered original article metadata at the exact observation; contains no source bodies.</summary>
public sealed record ArticleBlockTargetQueryArticleBatch(
    ArticleBlockTargetQueryObservation Observation,
    ImmutableArray<BlockTargetArticleQueryItem> Items);

/// <summary>One authorized exact article metadata read; absence and denial both return a null item.</summary>
public sealed record ArticleBlockTargetQueryArticleRead(
    ArticleBlockTargetQueryObservation Observation,
    BlockTargetArticleQueryItem? Item);

/// <summary>
/// Original canonical heading projections, never recovered from incoming links, titles, text or DOM.
/// Global parse diagnostics must be supplied before pagination; a blocked inventory has no items.
/// </summary>
public sealed record ArticleBlockTargetQueryHeadingBatch(
    ArticleBlockTargetQueryObservation Observation,
    BlockTargetArticleCoordinate Article,
    int SourceUtf16Length,
    BlockTargetInventoryDiagnostic Diagnostic,
    ImmutableArray<BlockTargetHeadingQueryItem> Items);

/// <summary>
/// Owned bounded read port for the sole target-query producer. This interface is not a production
/// permission, portable-identity or parser adapter. A registered implementation must reuse those
/// actual canonical authorities. It must filter permissions before search/limit and return at most
/// the requested metadata/projection rows, without parsing source bodies per result or exposing
/// private existence through rows, cursor, diagnostics, timing or errors. There is no default provider.
/// </summary>
public interface IArticleBlockTargetQuerySource
{
    Task<ArticleBlockTargetQueryObservation?> ObserveAsync(
        ArticleRelationActorContext actor,
        BlockTargetQueryScope scope,
        CancellationToken cancellationToken);

    Task<ArticleBlockTargetQueryArticleBatch> ReadArticlesAsync(
        ArticleBlockTargetQueryObservation observation,
        string search,
        string? afterArticleIdentity,
        int pageSize,
        CancellationToken cancellationToken);

    Task<ArticleBlockTargetQueryArticleRead> ReadArticleAsync(
        ArticleBlockTargetQueryObservation observation,
        string articleIdentity,
        CancellationToken cancellationToken);

    Task<ArticleBlockTargetQueryHeadingBatch> ReadHeadingsAsync(
        ArticleBlockTargetQueryObservation observation,
        BlockTargetArticleCoordinate article,
        string search,
        string? afterHeadingIdentity,
        int pageSize,
        CancellationToken cancellationToken);
}
