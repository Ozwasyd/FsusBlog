using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Complete canonical source sets for one portable article. The original producer supplies
/// parse, resolution and permission facts; this projection grants none of those authorities.
/// SourceSequence orders lifecycle observations, including an empty current set after deletion.
/// Published sets must remain present and immutable when current sources change.
/// </summary>
public sealed record ArticleRelationIndexArticle(
    string ArticleIdentity,
    long SourceSequence,
    ImmutableArray<ArticleRelationSet> Sets);

/// <summary>One ordinal article page from the original relation producer at an exact generation.</summary>
public sealed record ArticleRelationIndexSourcePage(
    ArticleRelationActorContext Actor,
    long SourceGeneration,
    ImmutableArray<ArticleRelationIndexArticle> Articles,
    bool HasMore);

/// <summary>One complete article family read from the original producer, including frozen publications.</summary>
public sealed record ArticleRelationIndexArticleRead(
    ArticleRelationActorContext Actor,
    long SourceGeneration,
    ArticleRelationIndexArticle Article);

/// <summary>
/// The sole index consumes canonical relation sets through this bounded read port. Its production
/// adapter must read actual parse/link results and current source/permission facts at the requested
/// generation. Neither a sealed contract nor an implementation of this interface proves admission.
/// </summary>
public interface IArticleRelationIndexSource
{
    Task<ArticleRelationIndexSourcePage> ReadAsync(
        ArticleRelationActorContext actor,
        string? afterArticleIdentity,
        int pageSize,
        long? expectedSourceGeneration,
        CancellationToken cancellationToken);

    Task<ArticleRelationIndexArticleRead> ReadArticleAsync(
        ArticleRelationActorContext actor,
        string articleIdentity,
        long? expectedSourceGeneration,
        CancellationToken cancellationToken);
}

/// <summary>
/// Immutable in-process index snapshot over the existing article/heading/block relation schema.
/// Target lookup is a projection of these same records, not a second relation store. This snapshot
/// is internal source capability, not durable storage or a permission-safe response/receipt.
/// </summary>
public sealed record ArticleRelationIndexSnapshot(
    ArticleRelationActorContext Actor,
    long IndexGeneration,
    long SourceGeneration,
    ImmutableSortedDictionary<string, ArticleRelationIndexArticle> Articles,
    ImmutableDictionary<ArticleRelationTargetIdentity, ImmutableArray<ArticleRelationRecord>> Targets);

/// <summary>
/// Unadmitted exact target candidates from an actual index read. Consumers must revalidate against
/// the original source and permission authority before exposing items, counts or impact plans.
/// </summary>
public sealed record ArticleRelationIndexInspection(
    ArticleRelationActorContext Actor,
    long IndexGeneration,
    long SourceGeneration,
    ArticleRelationTargetIdentity Target,
    ArticleRelationKind? Kind,
    ImmutableArray<ArticleRelationRecord> Records);

/// <summary>Closed, content-free index refusal; exceptions never carry source or target text.</summary>
public sealed class ArticleRelationIndexException(string reasonCode) : InvalidOperationException(reasonCode)
{
    public string ReasonCode => Message;
}
