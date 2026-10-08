using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;
using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Sole canonical relation-set index algorithm. Rebuild and lifecycle replacement stage immutable
/// sets before an expected-generation commit. Historical publications are never rewritten. Reads
/// expose unadmitted facts and cannot be wired directly to a public query or executable impact plan.
/// A durable store, observed parser/permission adapter and endpoint remain separate integration gates.
/// </summary>
public sealed class ArticleRelationIndex
{
    public const int BatchSize = 100;
    public const int MaxArticles = 10_000;
    public const int MaxSets = 100_000;
    public const int MaxRelations = 100_000;
    public const int MaxStoredTextCharacters = 32 * 1_024 * 1_024;

    private readonly object _sync = new();
    private readonly IArticleRelationIndexSource _source;
    private readonly ArticleRelationActorContext _actor;
    private ArticleRelationIndexSnapshot? _snapshot;

    public ArticleRelationIndex(IArticleRelationIndexSource source, ArticleRelationActorContext actor)
    {
        ArgumentNullException.ThrowIfNull(source);
        Require(ArticleRelationContractValidator.Validate(actor).IsValid, "article_relation_index_actor_invalid");
        _source = source;
        _actor = actor;
    }

    /// <summary>
    /// Rebuilds from ordinal bounded pages at one observed generation. A refused, cancelled or
    /// concurrent rebuild leaves the previous snapshot intact, including every frozen publication.
    /// </summary>
    public async Task<ArticleRelationIndexSnapshot> RebuildAsync(
        long expectedIndexGeneration,
        CancellationToken cancellationToken = default)
    {
        ArticleRelationIndexSnapshot? previous = Capture(expectedIndexGeneration, false);
        var articles = ImmutableSortedDictionary.CreateBuilder<string, ArticleRelationIndexArticle>(StringComparer.Ordinal);
        string? after = null;
        long? generation = null;
        var budget = new StorageBudget();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleRelationIndexSourcePage page = await _source.ReadAsync(
                _actor, after, BatchSize, generation, cancellationToken).ConfigureAwait(false);
            ValidatePage(page, generation);
            generation = page.SourceGeneration;
            foreach (ArticleRelationIndexArticle article in page.Articles)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Require(after is null || StringComparer.Ordinal.Compare(article.ArticleIdentity, after) > 0,
                    "article_relation_index_page_order_invalid");
                ArticleRelationIndexArticle held = OwnArticle(article, budget, page.SourceGeneration, cancellationToken);
                Require(articles.TryAdd(held.ArticleIdentity, held), "article_relation_index_article_duplicate");
                Require(articles.Count <= MaxArticles, "article_relation_index_article_budget_exceeded");
                after = held.ArticleIdentity;
            }
            if (!page.HasMore)
            {
                break;
            }
            Require(!page.Articles.IsEmpty, "article_relation_index_page_progress_missing");
        }

        // A final original-source read detects a generation change even for an empty corpus.
        ArticleRelationIndexSourcePage current = await _source.ReadAsync(
            _actor, null, 1, generation, cancellationToken).ConfigureAwait(false);
        ValidatePage(current, generation, 1);
        ImmutableSortedDictionary<string, ArticleRelationIndexArticle> staged = articles.ToImmutable();
        PreserveHistory(previous?.Articles, staged, cancellationToken);
        Require(previous is null || generation >= previous.SourceGeneration, "article_relation_index_source_generation_stale");
        Require(previous is null || generation != previous.SourceGeneration
            || SameCorpus(previous.Articles, staged), "article_relation_index_source_generation_conflict");
        ArticleRelationIndexSnapshot next = BuildSnapshot(staged, expectedIndexGeneration, generation!.Value, cancellationToken);
        return Commit(previous, next, cancellationToken);
    }

    /// <summary>
    /// Replaces one complete article family after rereading its canonical producer. Only the next
    /// global source generation is incremental; gaps require full rebuild instead of losing events.
    /// Repeated exact observations are idempotent. Stale or conflicting observations never commit.
    /// </summary>
    public async Task<ArticleRelationIndexSnapshot> ApplyAsync(
        string articleIdentity,
        long expectedIndexGeneration,
        CancellationToken cancellationToken = default)
    {
        Require(BlockAnchorContractValidator.IsStableArticleIdentity(articleIdentity), "article_relation_index_article_invalid");
        ArticleRelationIndexSnapshot previous = Capture(expectedIndexGeneration, true)!;
        cancellationToken.ThrowIfCancellationRequested();
        ArticleRelationIndexArticleRead read = await _source.ReadArticleAsync(
            _actor, articleIdentity, null, cancellationToken).ConfigureAwait(false);
        Require(read.Actor == _actor && read.SourceGeneration > 0 && read.Article.ArticleIdentity == articleIdentity,
            "article_relation_index_source_binding_mismatch");
        ArticleRelationIndexArticle article = OwnArticle(read.Article, new StorageBudget(), read.SourceGeneration, cancellationToken);
        Require(read.SourceGeneration >= previous.SourceGeneration, "article_relation_index_source_generation_stale");
        previous.Articles.TryGetValue(articleIdentity, out ArticleRelationIndexArticle? old);
        if (read.SourceGeneration == previous.SourceGeneration)
        {
            Require(old is not null && SameArticle(old, article), "article_relation_index_source_generation_conflict");
            cancellationToken.ThrowIfCancellationRequested();
            RequireCurrent(previous);
            return previous;
        }
        Require(previous.SourceGeneration < long.MaxValue && read.SourceGeneration == previous.SourceGeneration + 1,
            "article_relation_index_source_generation_gap");
        Require(old is null || article.SourceSequence > old.SourceSequence, "article_relation_index_source_sequence_stale");
        ImmutableSortedDictionary<string, ArticleRelationIndexArticle> staged = previous.Articles.SetItem(articleIdentity, article);
        Require(staged.Count <= MaxArticles, "article_relation_index_article_budget_exceeded");
        PreserveHistory(previous.Articles, staged, cancellationToken);
        ArticleRelationIndexSnapshot next = BuildSnapshot(staged, expectedIndexGeneration, read.SourceGeneration, cancellationToken);
        ArticleRelationIndexSourcePage current = await _source.ReadAsync(
            _actor, null, 1, read.SourceGeneration, cancellationToken).ConfigureAwait(false);
        ValidatePage(current, read.SourceGeneration, 1);
        return Commit(previous, next, cancellationToken);
    }

    /// <summary>Reads one exact immutable index generation; this is an internal authority input.</summary>
    public ArticleRelationIndexSnapshot ReadSnapshot(long expectedIndexGeneration)
        => Capture(expectedIndexGeneration, true)!;

    /// <summary>
    /// Inspects exact target records in the actual index, with cancellation and stale refusal.
    /// No count/item from this unadmitted inspection is a public response or permission receipt.
    /// </summary>
    public ArticleRelationIndexInspection InspectTarget(
        ArticleRelationTargetIdentity target,
        long expectedIndexGeneration,
        ArticleRelationKind? kind = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(ArticleRelationContractValidator.Validate(target).IsValid
            && (!kind.HasValue || Enum.IsDefined(kind.Value)), "article_relation_index_query_invalid");
        ArticleRelationIndexSnapshot snapshot = Capture(expectedIndexGeneration, true)!;
        var records = ImmutableArray.CreateBuilder<ArticleRelationRecord>();
        if (snapshot.Targets.TryGetValue(target, out ImmutableArray<ArticleRelationRecord> candidates))
        {
            foreach (ArticleRelationRecord record in candidates)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!kind.HasValue || record.Kind == kind.Value)
                {
                    records.Add(record);
                }
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        RequireCurrent(snapshot);
        return new(_actor, snapshot.IndexGeneration, snapshot.SourceGeneration, target, kind, records.ToImmutable());
    }

    /// <summary>Reads embed candidates in an explicit scope from the same committed source families.</summary>
    public ArticleRelationIndexEmbedInspection InspectEmbedTarget(
        ArticleEmbedTargetIdentity target,
        ArticleEmbedEdgeScope scope,
        long expectedIndexGeneration,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(ArticleEmbedTargetCodec.Validate(target).IsValid && Enum.IsDefined(scope),
            "article_relation_index_embed_query_invalid");
        ArticleRelationIndexSnapshot snapshot = Capture(expectedIndexGeneration, true)!;
        var entries = ImmutableArray.CreateBuilder<ArticleRelationIndexEmbedEntry>();
        if (snapshot.EmbedTargets.TryGetValue(target, out ImmutableArray<ArticleRelationIndexEmbedEntry> candidates))
        {
            foreach (ArticleRelationIndexEmbedEntry entry in candidates)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (entry.Edge.Scope == scope)
                {
                    entries.Add(entry);
                }
            }
        }
        RequireCurrent(snapshot);
        return new(_actor, snapshot.IndexGeneration, snapshot.SourceGeneration, target, scope, entries.ToImmutable());
    }

    /// <summary>Rechecks actual embed inspection parity and rereads original host families, including nested edges.</summary>
    public async Task RevalidateSourceAsync(
        ArticleRelationIndexEmbedInspection inspection,
        CancellationToken cancellationToken = default)
    {
        Require(inspection.Actor == _actor && !inspection.Entries.IsDefault, "article_relation_index_inspection_binding_invalid");
        ArticleRelationIndexSnapshot snapshot = Capture(inspection.IndexGeneration, true)!;
        ArticleRelationIndexEmbedInspection actual = InspectEmbedTarget(
            inspection.Target, inspection.Scope, inspection.IndexGeneration, cancellationToken);
        Require(inspection.SourceGeneration == actual.SourceGeneration && inspection.Entries.SequenceEqual(actual.Entries),
            "article_relation_index_inspection_tampered");
        await RevalidateFamiliesAsync(snapshot, inspection.Entries.Select(static entry => entry.HostArticleIdentity), cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Recomputes inspection parity from the actual index and sequentially rereads each affected
    /// complete source family through its original port. Fabricated, stale, actor-swapped or edited
    /// inspection facts are refused. Success grants no fresh permission or executable plan admission.
    /// </summary>
    public async Task RevalidateSourceAsync(
        ArticleRelationIndexInspection inspection,
        CancellationToken cancellationToken = default)
    {
        Require(inspection.Actor == _actor && !inspection.Records.IsDefault, "article_relation_index_inspection_binding_invalid");
        ArticleRelationIndexSnapshot snapshot = Capture(inspection.IndexGeneration, true)!;
        ArticleRelationIndexInspection actual = InspectTarget(
            inspection.Target, inspection.IndexGeneration, inspection.Kind, cancellationToken);
        Require(inspection.SourceGeneration == actual.SourceGeneration && inspection.Records.SequenceEqual(actual.Records),
            "article_relation_index_inspection_tampered");
        await RevalidateFamiliesAsync(snapshot, inspection.Records.Select(static record => record.Source.ArticleIdentity), cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task RevalidateFamiliesAsync(
        ArticleRelationIndexSnapshot snapshot,
        IEnumerable<string> identities,
        CancellationToken cancellationToken)
    {
        ArticleRelationIndexSourcePage first = await _source.ReadAsync(
            _actor, null, 1, snapshot.SourceGeneration, cancellationToken).ConfigureAwait(false);
        ValidatePage(first, snapshot.SourceGeneration, 1);
        foreach (string identity in identities.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleRelationIndexArticleRead read = await _source.ReadArticleAsync(
                _actor, identity, snapshot.SourceGeneration, cancellationToken).ConfigureAwait(false);
            Require(read.Actor == _actor && read.SourceGeneration == snapshot.SourceGeneration && read.Article.ArticleIdentity == identity,
                "article_relation_index_source_binding_mismatch");
            ArticleRelationIndexArticle current = OwnArticle(read.Article, new StorageBudget(), read.SourceGeneration, cancellationToken);
            Require(SameArticle(snapshot.Articles[identity], current), "article_relation_index_source_snapshot_stale");
        }
        ArticleRelationIndexSourcePage final = await _source.ReadAsync(
            _actor, null, 1, snapshot.SourceGeneration, cancellationToken).ConfigureAwait(false);
        ValidatePage(final, snapshot.SourceGeneration, 1);
        cancellationToken.ThrowIfCancellationRequested();
        RequireCurrent(snapshot);
    }

    private ArticleRelationIndexSnapshot? Capture(long expectedIndexGeneration, bool required)
    {
        lock (_sync)
        {
            Require(expectedIndexGeneration >= 0 && (_snapshot?.IndexGeneration ?? 0) == expectedIndexGeneration,
                "article_relation_index_generation_stale");
            Require(!required || _snapshot is not null, "article_relation_index_rebuild_required");
            return _snapshot;
        }
    }

    private void RequireCurrent(ArticleRelationIndexSnapshot snapshot)
    {
        lock (_sync)
        {
            Require(ReferenceEquals(_snapshot, snapshot), "article_relation_index_generation_stale");
        }
    }

    private ArticleRelationIndexSnapshot Commit(
        ArticleRelationIndexSnapshot? previous,
        ArticleRelationIndexSnapshot next,
        CancellationToken cancellationToken)
    {
        lock (_sync)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Require(ReferenceEquals(_snapshot, previous), "article_relation_index_generation_stale");
            _snapshot = next;
            return next;
        }
    }

    private void ValidatePage(ArticleRelationIndexSourcePage page, long? generation, int pageSize = BatchSize)
    {
        Require(page.Actor == _actor && page.SourceGeneration > 0
            && (!generation.HasValue || page.SourceGeneration == generation.Value)
            && !page.Articles.IsDefault && page.Articles.Length <= pageSize,
            "article_relation_index_source_page_invalid");
    }

    private ArticleRelationIndexArticle OwnArticle(
        ArticleRelationIndexArticle article,
        StorageBudget budget,
        long sourceGeneration,
        CancellationToken cancellationToken)
    {
        Require(BlockAnchorContractValidator.IsStableArticleIdentity(article.ArticleIdentity)
            && article.SourceSequence > 0 && !article.Sets.IsDefault && article.Sets.Length <= MaxSets
            && !article.Embeds.IsDefault && article.Embeds.Length <= MaxSets,
            "article_relation_index_source_article_invalid");
        var sets = new List<ArticleRelationSet>();
        var revisions = new HashSet<(ArticleRelationRevisionKind Kind, string Identity)>();
        var mutableKinds = new HashSet<ArticleRelationRevisionKind>();
        foreach (ArticleRelationSet input in article.Sets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Require(input.Relations is not null && input.Relations.Count <= MaxRelations,
                "article_relation_index_relation_budget_exceeded");
            var held = input with
            {
                Relations = input.Relations.ToImmutableArray()
            };
            budget.Add(held, cancellationToken);
            Require(ArticleRelationContractValidator.Validate(held).IsValid
                && held.Source.ArticleIdentity == article.ArticleIdentity
                && held.Source.SourceActor.SiteIdentity == _actor.SiteIdentity
                && held.Relations.All(record => record.Visibility.QueryActor == _actor),
                "article_relation_index_canonical_set_invalid");
            Require(revisions.Add((held.Source.RevisionKind, held.Source.RevisionIdentity)), "article_relation_index_revision_duplicate");
            Require(held.Source.RevisionKind == ArticleRelationRevisionKind.Published || mutableKinds.Add(held.Source.RevisionKind),
                "article_relation_index_current_revision_ambiguous");
            held = ArticleRelationContractValidator.Seal(held with
            {
                Relations = held.Relations.OrderBy(static record => record.RelationIdentity, StringComparer.Ordinal).ToImmutableArray()
            });
            sets.Add(held);
        }
        var embeds = new List<ArticleRelationIndexEmbedAdmission>();
        var embedIdentities = new HashSet<(ArticleEmbedEdgeScope Scope, string Document, long Epoch, long Revision)>();
        foreach (ArticleRelationIndexEmbedAdmission admission in article.Embeds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Require(admission is not null, "article_relation_index_embed_admission_invalid");
            ArticleEmbedRelationEdgeSet set = admission.EdgeSet;
            Require(set.HostPortableArticleIdentity == article.ArticleIdentity
                && set.Actor.ActorIdentity == _actor.ActorIdentity && set.Actor.SiteIdentity == _actor.SiteIdentity
                && set.Actor.PermissionContextDigest == _actor.PermissionContextDigest
                && admission.SourceGeneration <= sourceGeneration && admission.HostSourceSequence <= article.SourceSequence
                && (set.Scope != ArticleEmbedEdgeScope.Authoring
                    || admission.HostSourceSequence == article.SourceSequence),
                "article_relation_index_embed_binding_invalid");
            Require(embedIdentities.Add((set.Scope, set.HostDocument.Id, set.HostDocument.Epoch, set.HostSourceRevision)),
                "article_relation_index_embed_duplicate");
            budget.Add(admission, cancellationToken);
            embeds.Add(admission);
        }
        return article with
        {
            Sets = sets.OrderBy(static set => set.Source.RevisionIdentity, StringComparer.Ordinal).ToImmutableArray(),
            Embeds = embeds.OrderBy(static embed => embed.EdgeSet.Scope)
                .ThenBy(static embed => embed.EdgeSet.HostDocument.Id, StringComparer.Ordinal)
                .ThenBy(static embed => embed.EdgeSet.HostDocument.Epoch)
                .ThenBy(static embed => embed.EdgeSet.HostSourceRevision).ToImmutableArray()
        };
    }

    private ArticleRelationIndexSnapshot BuildSnapshot(
        ImmutableSortedDictionary<string, ArticleRelationIndexArticle> articles,
        long expectedIndexGeneration,
        long sourceGeneration,
        CancellationToken cancellationToken)
    {
        Require(expectedIndexGeneration < long.MaxValue, "article_relation_index_generation_exhausted");
        var budget = new StorageBudget();
        var targets = new Dictionary<ArticleRelationTargetIdentity, List<ArticleRelationRecord>>();
        var embedTargets = new Dictionary<ArticleEmbedTargetIdentity, List<ArticleRelationIndexEmbedEntry>>();
        foreach (ArticleRelationIndexArticle article in articles.Values)
        {
            foreach (ArticleRelationSet set in article.Sets)
            {
                cancellationToken.ThrowIfCancellationRequested();
                budget.Add(set, cancellationToken);
                foreach (ArticleRelationRecord record in set.Relations)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (record.Target.TargetIdentity is not ArticleRelationTargetIdentity target)
                    {
                        continue;
                    }
                    if (!targets.TryGetValue(target, out List<ArticleRelationRecord>? records))
                    {
                        records = [];
                        targets.Add(target, records);
                    }
                    records.Add(record);
                }
            }
            foreach (ArticleRelationIndexEmbedAdmission admission in article.Embeds)
            {
                budget.Add(admission, cancellationToken);
                Dictionary<string, ArticleEmbedDependencyReceipt> receipts = admission.DependencyReceipts
                    .ToDictionary(static receipt => receipt.EdgeIdentity, StringComparer.Ordinal);
                for (int i = 0; i < admission.EdgeSet.Edges.Count; i++)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    ArticleEmbedRelationEdge edge = admission.EdgeSet.Edges[i];
                    if (!embedTargets.TryGetValue(edge.Target, out List<ArticleRelationIndexEmbedEntry>? entries))
                    {
                        entries = [];
                        embedTargets.Add(edge.Target, entries);
                    }
                    receipts.TryGetValue(edge.EdgeIdentity, out ArticleEmbedDependencyReceipt? receipt);
                    entries.Add(new(article.ArticleIdentity, admission, edge, admission.Coordinates[i], receipt));
                }
            }
        }
        return new(_actor, expectedIndexGeneration + 1, sourceGeneration, articles,
            targets.ToImmutableDictionary(static pair => pair.Key, static pair => pair.Value
                .OrderBy(static record => record.RelationIdentity, StringComparer.Ordinal).ToImmutableArray()))
        {
            EmbedTargets = embedTargets.ToImmutableDictionary(static pair => pair.Key, static pair => pair.Value
                .OrderBy(static entry => entry.HostArticleIdentity, StringComparer.Ordinal)
                .ThenBy(static entry => entry.Admission.EdgeSet.Scope)
                .ThenBy(static entry => entry.Admission.EdgeSet.HostDocument.Id, StringComparer.Ordinal)
                .ThenBy(static entry => entry.Admission.EdgeSet.HostDocument.Epoch)
                .ThenBy(static entry => entry.Admission.EdgeSet.HostSourceRevision)
                .ThenBy(static entry => entry.Edge.EdgeIdentity, StringComparer.Ordinal).ToImmutableArray())
        };
    }

    private static void PreserveHistory(
        ImmutableSortedDictionary<string, ArticleRelationIndexArticle>? previous,
        ImmutableSortedDictionary<string, ArticleRelationIndexArticle> staged,
        CancellationToken cancellationToken)
    {
        if (previous is null)
        {
            return;
        }
        foreach (ArticleRelationIndexArticle old in previous.Values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            staged.TryGetValue(old.ArticleIdentity, out ArticleRelationIndexArticle? next);
            if (next is not null)
            {
                Require(next.SourceSequence >= old.SourceSequence
                    && (next.SourceSequence != old.SourceSequence || SameArticle(old, next)),
                    "article_relation_index_source_sequence_stale");
            }
            Dictionary<string, string>? nextPublications = next?.Sets
                .Where(static set => set.Source.RevisionKind == ArticleRelationRevisionKind.Published)
                .ToDictionary(static set => set.Source.RevisionIdentity, static set => set.SetDigest, StringComparer.Ordinal);
            foreach (ArticleRelationSet frozen in old.Sets.Where(static set => set.Source.RevisionKind == ArticleRelationRevisionKind.Published))
            {
                cancellationToken.ThrowIfCancellationRequested();
                Require(nextPublications is not null
                    && nextPublications.TryGetValue(frozen.Source.RevisionIdentity, out string? digest) && digest == frozen.SetDigest,
                    "article_relation_index_history_immutable");
            }
            Dictionary<(string Document, long Epoch, long Revision), ArticleRelationIndexEmbedAdmission>? nextEmbeds = next?.Embeds
                .Where(static embed => embed.EdgeSet.Scope == ArticleEmbedEdgeScope.FrozenPublication)
                .ToDictionary(static embed => (embed.EdgeSet.HostDocument.Id, embed.EdgeSet.HostDocument.Epoch, embed.EdgeSet.HostSourceRevision));
            foreach (ArticleRelationIndexEmbedAdmission frozen in old.Embeds
                .Where(static embed => embed.EdgeSet.Scope == ArticleEmbedEdgeScope.FrozenPublication))
            {
                cancellationToken.ThrowIfCancellationRequested();
                Require(nextEmbeds is not null
                    && nextEmbeds.TryGetValue((frozen.EdgeSet.HostDocument.Id, frozen.EdgeSet.HostDocument.Epoch,
                        frozen.EdgeSet.HostSourceRevision), out ArticleRelationIndexEmbedAdmission? current)
                    && frozen.SameBinding(current), "article_relation_index_embed_history_immutable");
            }
        }
    }

    private static bool SameArticle(ArticleRelationIndexArticle left, ArticleRelationIndexArticle right)
        => left.ArticleIdentity == right.ArticleIdentity && left.SourceSequence == right.SourceSequence
            && left.Sets.Select(static set => set.SetDigest).SequenceEqual(right.Sets.Select(static set => set.SetDigest))
            && left.Embeds.Length == right.Embeds.Length
            && left.Embeds.Zip(right.Embeds).All(static pair => pair.First.SameBinding(pair.Second));

    private static bool SameCorpus(
        ImmutableSortedDictionary<string, ArticleRelationIndexArticle> left,
        ImmutableSortedDictionary<string, ArticleRelationIndexArticle> right)
        => left.Count == right.Count && left.All(pair => right.TryGetValue(pair.Key, out ArticleRelationIndexArticle? article)
            && SameArticle(pair.Value, article));

    private static void Require([DoesNotReturnIf(false)] bool condition, string reasonCode)
    {
        if (!condition)
        {
            throw new ArticleRelationIndexException(reasonCode);
        }
    }

    private sealed class StorageBudget
    {
        private long _sets;
        private long _relations;
        private long _textCharacters;

        public void Add(ArticleRelationIndexEmbedAdmission admission, CancellationToken cancellationToken)
        {
            _sets++;
            _relations += admission.EdgeSet.Edges.Count;
            Require(_sets <= MaxSets && _relations <= MaxRelations, "article_relation_index_storage_budget_exceeded");
            foreach (ArticleEmbedRelationEdge edge in admission.EdgeSet.Edges)
            {
                cancellationToken.ThrowIfCancellationRequested();
                _textCharacters += edge.Directive.TargetToken.Length;
                Require(_textCharacters <= MaxStoredTextCharacters, "article_relation_index_text_budget_exceeded");
            }
        }

        public void Add(ArticleRelationSet set, CancellationToken cancellationToken)
        {
            _sets++;
            _relations += set.Relations.Count;
            Require(_sets <= MaxSets && _relations <= MaxRelations, "article_relation_index_storage_budget_exceeded");
            foreach (ArticleRelationRecord record in set.Relations)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Require(record?.Occurrence?.LinkText is not null && record.Occurrence.First?.MatchedText is not null
                    && record.Occurrence.Last?.MatchedText is not null, "article_relation_index_canonical_set_invalid");
                _textCharacters += (long)record.Occurrence.LinkText.Length
                    + record.Occurrence.First.MatchedText.Length + record.Occurrence.Last.MatchedText.Length;
                Require(_textCharacters <= MaxStoredTextCharacters, "article_relation_index_text_budget_exceeded");
            }
        }
    }
}
