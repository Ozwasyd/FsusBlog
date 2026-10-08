using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;

using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Actual source integration for the sole relation index. It consumes original parsed families,
/// preserves their non-block records, and merges canonical block production before returning a
/// complete family. No second store/parser/permission provider or partial source set is introduced.
/// </summary>
public sealed class ArticleBlockRelationIndexSource(IArticleBlockRelationParsedSource source) : IArticleRelationIndexSource
{
    public async Task<ArticleRelationIndexSourcePage> ReadAsync(
        ArticleRelationActorContext actor,
        string? afterArticleIdentity,
        int pageSize,
        long? expectedSourceGeneration,
        CancellationToken cancellationToken)
    {
        Require(ArticleRelationContractValidator.Validate(actor).IsValid
            && pageSize is > 0 and <= ArticleRelationIndex.BatchSize, "article_block_relation_read_invalid");
        cancellationToken.ThrowIfCancellationRequested();
        ArticleBlockRelationParsedPage page = await source.ReadAsync(
            actor, afterArticleIdentity, pageSize, expectedSourceGeneration, cancellationToken).ConfigureAwait(false);
        Require(page.Actor == actor && page.SourceGeneration > 0
            && (!expectedSourceGeneration.HasValue || page.SourceGeneration == expectedSourceGeneration.Value)
            && !page.Articles.IsDefault && page.Articles.Length <= pageSize,
            "article_block_relation_read_stale");
        var articles = ImmutableArray.CreateBuilder<ArticleRelationIndexArticle>();
        int sets = 0;
        int relations = 0;
        foreach (ArticleBlockRelationParsedArticle article in page.Articles)
        {
            ArticleRelationIndexArticle produced = Produce(article, actor, page.SourceGeneration, cancellationToken);
            sets += produced.Sets.Length;
            relations += produced.Sets.Sum(static set => set.Relations.Count);
            Require(sets <= ArticleRelationIndex.MaxSets && relations <= ArticleRelationIndex.MaxRelations,
                "article_block_relation_page_budget_exceeded");
            articles.Add(produced);
        }
        cancellationToken.ThrowIfCancellationRequested();
        return new(actor, page.SourceGeneration, articles.ToImmutable(), page.HasMore);
    }

    public async Task<ArticleRelationIndexArticleRead> ReadArticleAsync(
        ArticleRelationActorContext actor,
        string articleIdentity,
        long? expectedSourceGeneration,
        CancellationToken cancellationToken)
    {
        Require(ArticleRelationContractValidator.Validate(actor).IsValid
            && BlockAnchorContractValidator.IsStableArticleIdentity(articleIdentity), "article_block_relation_read_invalid");
        cancellationToken.ThrowIfCancellationRequested();
        ArticleBlockRelationParsedArticleRead read = await source.ReadArticleAsync(
            actor, articleIdentity, expectedSourceGeneration, cancellationToken).ConfigureAwait(false);
        Require(read.Actor == actor && read.SourceGeneration > 0
            && (!expectedSourceGeneration.HasValue || read.SourceGeneration == expectedSourceGeneration.Value)
            && read.Article.ArticleIdentity == articleIdentity, "article_block_relation_read_stale");
        ArticleRelationIndexArticle article = Produce(read.Article, actor, read.SourceGeneration, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        return new(actor, read.SourceGeneration, article);
    }

    private static ArticleRelationIndexArticle Produce(
        ArticleBlockRelationParsedArticle article,
        ArticleRelationActorContext actor,
        long generation,
        CancellationToken cancellationToken)
    {
        Require(BlockAnchorContractValidator.IsStableArticleIdentity(article.ArticleIdentity) && article.SourceSequence > 0
            && !article.Revisions.IsDefault && article.Revisions.Length <= ArticleRelationIndex.MaxSets,
            "article_block_relation_family_invalid");
        var sets = ImmutableArray.CreateBuilder<ArticleRelationSet>();
        var coordinates = new HashSet<(ArticleRelationRevisionKind Kind, string Identity)>();
        var mutableKinds = new HashSet<ArticleRelationRevisionKind>();
        int totalRelations = 0;
        foreach (ArticleBlockRelationParsedRevision revision in article.Revisions)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleRelationSet original = revision.NonBlockSet;
            ArticleBlockRelationProductionInput input = revision.BlockInput;
            Require(original.Relations is not null && original.Relations.Count <= ArticleRelationIndex.MaxRelations,
                "article_block_relation_base_invalid");
            original = original with
            {
                Relations = original.Relations.ToImmutableArray()
            };
            Require(ArticleRelationContractValidator.Validate(original).IsValid
                && original.Source == input.Source && input.Source.ArticleIdentity == article.ArticleIdentity
                && input.SourceGeneration == generation && input.Visibility.QueryActor == actor
                && original.Relations.All(record => record.Visibility.QueryActor == actor), "article_block_relation_base_binding_invalid");
            Require(coordinates.Add((input.Source.RevisionKind, input.Source.RevisionIdentity))
                && (input.Source.RevisionKind == ArticleRelationRevisionKind.Published || mutableKinds.Add(input.Source.RevisionKind)),
                "article_block_relation_revision_ambiguous");
            Require(original.Relations.All(static record => record.Target.TargetIdentity?.Kind != ArticleRelationTargetKind.Block),
                "article_block_relation_second_producer_refused");
            ArticleBlockRelationProduction result = ArticleBlockRelationProducer.Produce(input, cancellationToken);
            if (!result.Produced)
            {
                throw new ArticleRelationIndexException(result.ReasonCode!);
            }
            totalRelations += original.Relations.Count + result.Set!.Relations.Count;
            Require(totalRelations <= ArticleRelationIndex.MaxRelations, "article_block_relation_family_budget_exceeded");
            ArticleRelationSet merged = ArticleRelationContractValidator.Seal(original with
            {
                Relations = original.Relations.Concat(result.Set.Relations)
                    .OrderBy(static record => record.RelationIdentity, StringComparer.Ordinal).ToImmutableArray()
            });
            Require(ArticleRelationContractValidator.Validate(merged).IsValid, "article_block_relation_merged_set_invalid");
            sets.Add(merged);
        }
        return new(article.ArticleIdentity, article.SourceSequence,
            sets.OrderBy(static set => set.Source.RevisionIdentity, StringComparer.Ordinal).ToImmutableArray())
        {
            Embeds = article.Embeds
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
