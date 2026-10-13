using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Sole incoming-impact preparation over the actual relation index and existing metadata port.
/// No source scan, writer, parser, transport or permission authority is introduced. Real runtime
/// admission requires the original providers; this algorithm never executes a frozen candidate.
/// </summary>
public sealed class ArticleBlockAnchorImpactPlanner(ArticleRelationIndex index, IArticleBlockTargetQuerySource source)
{
    public const int MaximumAffectedArticles = ArticleRelationIndex.MaxArticles;
    public const int MaximumOccurrences = ArticleRelationIndex.MaxRelations;

    public async Task<ArticleBlockAnchorImpactResult> FreezeAsync(
        ArticleBlockAnchorImpactRequest request,
        CancellationToken cancellationToken = default)
    {
        ValidateRequest(request);
        if (request.Operation == ArticleBlockAnchorImpactOperation.Remove
            && request.RemovalChoice == ArticleBlockAnchorRemovalChoice.Cancel)
        {
            return new(ArticleBlockAnchorImpactStatus.Cancelled, null);
        }
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleBlockTargetQueryObservation expected = request.ExpectedObservation;
            ArticleRelationActorContext actor = Actor(expected);
            Require(await source.ObserveAsync(actor, expected.Scope, cancellationToken).ConfigureAwait(false) == expected);
            ArticleRelationIndexSnapshot snapshot = index.ReadSnapshot(expected.IndexGeneration);
            Require(snapshot.Actor == actor && snapshot.SourceGeneration == expected.SourceGeneration);
            BlockTargetArticleCoordinate target = await ReadCurrentAsync(request.TargetArticle.ArticleIdentity, expected, cancellationToken)
                .ConfigureAwait(false);
            Require(target == request.TargetArticle && target.EditPermission == ArticleRelationPermissionState.Allowed
                && target.Lifecycle is not ArticleRelationLifecycleState.Archived and not ArticleRelationLifecycleState.Deleted);
            RequireIndexed(snapshot, target);
            ArticleRelationIndexInspection inspection = index.InspectTarget(
                new(target.ArticleIdentity, ArticleRelationTargetKind.Block, null, request.OldAnchor.Value),
                expected.IndexGeneration, cancellationToken: cancellationToken);
            Require(inspection.SourceGeneration == expected.SourceGeneration && inspection.Records.Length <= MaximumOccurrences);
            var current = new Dictionary<string, BlockTargetArticleCoordinate>(StringComparer.Ordinal)
            {
                [target.ArticleIdentity] = target
            };
            var articleIds = new HashSet<string>(StringComparer.Ordinal);
            var items = ImmutableArray.CreateBuilder<ArticleBlockAnchorImpactItem>();
            long textCharacters = 0;
            foreach (IGrouping<string, ArticleRelationRecord> group in inspection.Records.GroupBy(static record => record.Source.ArticleIdentity)
                .OrderBy(static group => group.Key, StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                Require(articleIds.Add(group.Key) && articleIds.Count <= MaximumAffectedArticles);
                // Current read denial also conceals historical incoming references. A current
                // article read is not a grant to expose past revision content; that separate
                // canonical history permission admission remains explicit on the frozen plan.
                if (!current.TryGetValue(group.Key, out BlockTargetArticleCoordinate? currentArticle))
                {
                    currentArticle = await ReadCurrentAsync(group.Key, expected, cancellationToken).ConfigureAwait(false);
                    current.Add(group.Key, currentArticle);
                }
                foreach (ArticleRelationRecord record in group.OrderBy(static record => record.Source.RevisionIdentity, StringComparer.Ordinal)
                    .ThenBy(static record => record.Occurrence.First.Start).ThenBy(static record => record.RelationIdentity, StringComparer.Ordinal))
                {
                    Require(record.Source.Permission == ArticleRelationPermissionState.Allowed
                        && record.Visibility.QueryActor == actor
                        && record.Visibility.QueryScope == ArticleRelationQueryScope.Authoring
                        && record.Kind != ArticleRelationKind.UnlinkedMention);
                    // The aggregate schema exposes only first/last. Three or more occurrences
                    // cannot be silently reduced to two executable source ranges.
                    Require(record.Occurrence.Count is 1 or 2);
                    bool historical = record.Source.RevisionKind == ArticleRelationRevisionKind.Published;
                    BlockTargetArticleCoordinate? article = null;
                    if (!historical)
                    {
                        article = currentArticle;
                        RequireMatches(record.Source, article);
                        RequireIndexed(snapshot, article);
                    }
                    ArticleBlockAnchorImpactDisposition disposition = Disposition(request, historical, article);
                    ImmutableArray<ArticleRelationSourceRange> ranges = record.Occurrence.Count == 1
                        ? [record.Occurrence.First] : [record.Occurrence.First, record.Occurrence.Last];
                    Require(record.Occurrence.Count != 1 || record.Occurrence.First == record.Occurrence.Last);
                    foreach (ArticleRelationSourceRange range in ranges)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        Require(range.End - range.Start == range.MatchedText.Length
                            && BlockAnchorMarkdownParser.TryParse(range.MatchedText, out BlockAnchorMarkdownLink? parsed).IsValid
                            && parsed!.AnchorId == request.OldAnchor);
                        // Reuse the original single-literal codec and builder. Never normalize
                        // an existing route or label as a side effect of an anchor rename.
                        BlockAnchorMarkdownParser.TryParse(range.MatchedText, out BlockAnchorMarkdownLink? link);
                        string before = range.MatchedText;
                        string originalSlug = Uri.UnescapeDataString(link!.RoutePath[BlockAnchorSchemas.MarkdownRoutePrefix.Length..]);
                        Require(BlockAnchorMarkdownBuilder.Build(link.DisplayText, originalSlug,
                            new(target.ArticleIdentity, request.OldAnchor)) == before);
                        string after = disposition == ArticleBlockAnchorImpactDisposition.RenameCurrentLink
                            ? BlockAnchorMarkdownBuilder.Build(link.DisplayText, originalSlug,
                                new(target.ArticleIdentity, request.NewAnchor!.Value)) : before;
                        textCharacters += (long)before.Length + after.Length;
                        Require(textCharacters <= ArticleRelationIndex.MaxStoredTextCharacters && items.Count < MaximumOccurrences);
                        items.Add(new(record, range, before, after, article, disposition));
                    }
                }
            }
            ImmutableArray<ArticleBlockAnchorImpactItem> frozen = items.OrderBy(static item => item.Record.Source.ArticleIdentity, StringComparer.Ordinal)
                .ThenBy(static item => item.Record.Source.RevisionKind)
                .ThenBy(static item => item.Record.Source.RevisionIdentity, StringComparer.Ordinal)
                .ThenBy(static item => item.Range.Start).ToImmutableArray();
            ArticleBlockAnchorImpactItem? previous = null;
            foreach (ArticleBlockAnchorImpactItem item in frozen)
            {
                Require(previous is null || previous.Record.Source.ArticleIdentity != item.Record.Source.ArticleIdentity
                    || previous.Record.Source.RevisionKind != item.Record.Source.RevisionKind
                    || previous.Record.Source.RevisionIdentity != item.Record.Source.RevisionIdentity
                    || previous.Range.End <= item.Range.Start);
                previous = item;
            }
            await index.RevalidateSourceAsync(inspection, cancellationToken).ConfigureAwait(false);
            // An empty incoming impact is not proof that the target's own family is unchanged.
            await index.RevalidateArticleAsync(target.ArticleIdentity, expected.IndexGeneration, cancellationToken).ConfigureAwait(false);
            foreach ((string identity, BlockTargetArticleCoordinate expectedArticle) in current.OrderBy(static entry => entry.Key, StringComparer.Ordinal))
            {
                Require(await ReadCurrentAsync(identity, expected, cancellationToken).ConfigureAwait(false) == expectedArticle);
            }
            Require(await source.ObserveAsync(actor, expected.Scope, cancellationToken).ConfigureAwait(false) == expected);
            cancellationToken.ThrowIfCancellationRequested();
            ImmutableSortedDictionary<string, BlockTargetArticleCoordinate> currentArticles = current.ToImmutableSortedDictionary(StringComparer.Ordinal);
            return new(ArticleBlockAnchorImpactStatus.Frozen, new(request, inspection, frozen, currentArticles,
                ComputeDigest(request, inspection, frozen, currentArticles)));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return new(ArticleBlockAnchorImpactStatus.Cancelled, null);
        }
        catch (Exception)
        {
            return new(ArticleBlockAnchorImpactStatus.Unavailable, null);
        }
    }

    /// <summary>Prepare-only revalidation; execution must use a separately admitted frozen transaction.</summary>
    public async Task<bool> RevalidateAsync(ArticleBlockAnchorImpactPlan? plan, CancellationToken cancellationToken = default)
    {
        if (plan is null)
        {
            return false;
        }
        try
        {
            Require(plan.Inspection.Records.All(static record => ArticleRelationContractValidator.Validate(record).IsValid)
                && plan.Items.All(static item => ArticleRelationContractValidator.Validate(item.Record).IsValid
                    && item.BeforeMarkdown == item.Range.MatchedText
                    && (item.Range == item.Record.Occurrence.First || item.Range == item.Record.Occurrence.Last))
                && ComputeDigest(plan.Request, plan.Inspection, plan.Items, plan.CurrentArticles) == plan.OperationDigest);
            ArticleBlockAnchorImpactResult actual = await FreezeAsync(plan.Request, cancellationToken).ConfigureAwait(false);
            return actual.Plan is not null && actual.Plan.OperationDigest == plan.OperationDigest;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private async Task<BlockTargetArticleCoordinate> ReadCurrentAsync(
        string articleIdentity, ArticleBlockTargetQueryObservation observation, CancellationToken cancellationToken)
    {
        ArticleBlockTargetQueryArticleRead read = await source.ReadArticleAsync(observation, articleIdentity, cancellationToken).ConfigureAwait(false);
        Require(read.Observation == observation && read.Item is not null);
        BlockTargetArticleCoordinate article = read.Item!.Article;
        Require(article.ArticleIdentity == articleIdentity && article.Permission == ArticleRelationPermissionState.Allowed
            && IsArticle(article, observation) && article.RevisionIdentity.Length <= 256 && article.CanonicalSlug.Length <= 256);
        return article;
    }

    private static void RequireIndexed(ArticleRelationIndexSnapshot snapshot, BlockTargetArticleCoordinate article)
    {
        Require(snapshot.Articles.TryGetValue(article.ArticleIdentity, out ArticleRelationIndexArticle? family)
            && family.Sets.Any(set => Matches(set.Source, article)));
    }

    private static void RequireMatches(ArticleRelationSourceFacts sourceFacts, BlockTargetArticleCoordinate article)
        => Require(Matches(sourceFacts, article));

    private static bool Matches(ArticleRelationSourceFacts sourceFacts, BlockTargetArticleCoordinate article)
        => sourceFacts.ArticleIdentity == article.ArticleIdentity && sourceFacts.RevisionIdentity == article.RevisionIdentity
            && sourceFacts.RevisionNumber == article.RevisionNumber && sourceFacts.RevisionKind == article.RevisionKind
            && sourceFacts.ContentDigest == article.ContentDigest && sourceFacts.Lifecycle == article.Lifecycle
            && sourceFacts.Permission == article.Permission;

    private static bool IsArticle(BlockTargetArticleCoordinate article, ArticleBlockTargetQueryObservation observation)
    {
        var request = new BlockTargetQueryRequest(BlockTargetQuerySchemas.Request, BlockTargetQuerySchemas.Version,
            observation.Coordinate, BlockTargetQueryLayer.Blocks, observation.Scope, article, string.Empty, 1, 1, string.Empty);
        request = request with
        {
            RequestDigest = BlockTargetQueryDigest.ComputeRequest(request)
        };
        return BlockTargetQueryValidator.Validate(request).IsValid;
    }

    private static void ValidateRequest(ArticleBlockAnchorImpactRequest? request)
    {
        Require(request is not null && request.RequestId is { Length: > 0 and <= 256 }
            && !request.RequestId.Any(char.IsControl) && Enum.IsDefined(request.Operation) && Enum.IsDefined(request.RemovalChoice)
            && request.ExpectedObservation is { Scope: BlockTargetQueryScope.AuthoringCurrent, SourceGeneration: > 0, IndexGeneration: > 0 }
            && IsArticle(request.TargetArticle, request.ExpectedObservation)
            && BlockAnchorContractValidator.Validate(request.OldAnchor).IsValid
            && (request.Operation == ArticleBlockAnchorImpactOperation.Rename
                ? request.NewAnchor.HasValue && BlockAnchorContractValidator.Validate(request.NewAnchor.Value).IsValid
                    && request.NewAnchor.Value != request.OldAnchor
                : request.NewAnchor is null));
    }

    private static ArticleBlockAnchorImpactDisposition Disposition(
        ArticleBlockAnchorImpactRequest request, bool historical, BlockTargetArticleCoordinate? article)
        => historical ? ArticleBlockAnchorImpactDisposition.ImmutableHistory
            : article!.EditPermission != ArticleRelationPermissionState.Allowed ? ArticleBlockAnchorImpactDisposition.BlockedCurrentEdit
            : article.Lifecycle is ArticleRelationLifecycleState.Archived or ArticleRelationLifecycleState.Deleted
                ? ArticleBlockAnchorImpactDisposition.BlockedCurrentLifecycle
            : request.Operation == ArticleBlockAnchorImpactOperation.Rename ? ArticleBlockAnchorImpactDisposition.RenameCurrentLink
            : request.RemovalChoice == ArticleBlockAnchorRemovalChoice.LeaveBrokenExplicitly
                ? ArticleBlockAnchorImpactDisposition.KeepBrokenExplicitly : ArticleBlockAnchorImpactDisposition.BlockedRemovalReferences;

    private static ArticleRelationActorContext Actor(ArticleBlockTargetQueryObservation observation)
        => new(observation.Coordinate.ActorIdentity, observation.Coordinate.SiteIdentity, observation.Coordinate.PermissionContextDigest);

    private static string ComputeDigest(ArticleBlockAnchorImpactRequest request, ArticleRelationIndexInspection inspection,
        ImmutableArray<ArticleBlockAnchorImpactItem> items, ImmutableSortedDictionary<string, BlockTargetArticleCoordinate> currentArticles)
    {
        // Versioned, internal operation fingerprint. Existing relation digests bind the original
        // record facts. This is not an anchor codec, portable identity or execution receipt.
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            Domain = "fsusblog.block-anchor-impact-candidate.v1",
            Request = request,
            inspection.IndexGeneration,
            inspection.SourceGeneration,
            inspection.Actor,
            inspection.Target,
            inspection.Kind,
            RelationDigests = inspection.Records.Select(static record => record.RecordDigest).ToArray(),
            CurrentArticles = currentArticles,
            Items = items.Select(static item => new
            {
                item.Record.RecordDigest,
                item.Range.Start,
                item.Range.End,
                item.BeforeMarkdown,
                item.AfterMarkdown,
                item.CurrentArticle,
                item.Disposition
            }).ToArray()
        });
        return Convert.ToHexStringLower(SHA256.HashData(payload));
    }

    private static void Require([DoesNotReturnIf(false)] bool condition)
    {
        if (!condition)
        {
            throw new ArticleRelationIndexException("block_anchor_impact_unavailable");
        }
    }
}
