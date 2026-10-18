using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;

using FsusBlog.Server.Infrastructure.Execution;
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
    private AdjacencyTopology? _adjacency;

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
        PreparedSnapshot next = BuildSnapshot(staged, expectedIndexGeneration, generation!.Value, cancellationToken);
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
        PreparedSnapshot next = BuildSnapshot(staged, expectedIndexGeneration, read.SourceGeneration, cancellationToken);
        ArticleRelationIndexSourcePage current = await _source.ReadAsync(
            _actor, null, 1, read.SourceGeneration, cancellationToken).ConfigureAwait(false);
        ValidatePage(current, read.SourceGeneration, 1);
        return Commit(previous, next, cancellationToken);
    }

    /// <summary>Reads one exact immutable index generation; this is an internal authority input.</summary>
    public ArticleRelationIndexSnapshot ReadSnapshot(long expectedIndexGeneration)
        => Capture(expectedIndexGeneration, true)!;

    /// <summary>Article-level direction; heading/block subtree expansion belongs to its explicit authority.</summary>
    [Flags]
    public enum AdjacencyDirections : byte
    {
        Incoming = 1,
        Outgoing = 2,
        Both = Incoming | Outgoing
    }

    /// <summary>The authority must distinguish a requested root, source, target and nested embed host.</summary>
    public enum AdjacencyPermissionRole : byte
    {
        Root = 1,
        Source = 2,
        Target = 3,
        EmbedHost = 4
    }

    /// <summary>
    /// Original coordinates only. Missing embed revision identity/kind remain null; scope is a hint,
    /// never a fabricated revision coordinate. The authority must resolve missing bindings independently.
    /// </summary>
    public sealed record AdjacencyPermissionCoordinate(
        string ArticleIdentity,
        string? RevisionIdentity,
        long? RevisionNumber,
        ArticleRelationRevisionKind? RevisionKind,
        ArticleRelationTargetIdentity? LinkTarget,
        ArticleEmbedTargetIdentity? EmbedTarget,
        ArticleEmbedEdgeScope? EmbedScope,
        AdjacencyPermissionRole Role,
        ArticleEmbedDocumentIdentity? HostDocument = null,
        long? HostSourceSequence = null,
        long? HostSourceGeneration = null);

    /// <summary>Observed, opaque live authority versions; none is inferred from an index or caller boolean.</summary>
    public sealed record AdjacencyObservation(
        ArticleRelationActorContext Actor,
        long IndexGeneration,
        long SourceGeneration,
        long DocumentEpoch,
        string DocumentIdentity,
        ArticleRelationQueryScope Scope,
        string PermissionRevision,
        string SiteRevision,
        string SessionRevision);

    /// <summary>A decision must bind the exact observation and original requested coordinate.</summary>
    public sealed record AdjacencyPermissionDecision(
        AdjacencyObservation Observation,
        AdjacencyPermissionCoordinate Coordinate,
        ArticleRelationPermissionState Permission);

    /// <summary>
    /// Read-only live permission port. Production wiring must observe actual actor/session/site,
    /// document and source versions, and authorize every exact coordinate; this interface grants none.
    /// Implementations must honor cancellation and perform bounded reads before materializing facts.
    /// </summary>
    public interface IAdjacencyAuthority
    {
        Task<AdjacencyObservation?> ObserveAsync(
            ArticleRelationActorContext actor,
            ArticleRelationQueryScope scope,
            CancellationToken cancellationToken);

        Task<AdjacencyPermissionDecision?> ReadPermissionAsync(
            AdjacencyObservation observation,
            AdjacencyPermissionCoordinate coordinate,
            CancellationToken cancellationToken);
    }

    /// <summary>Exact root and frozen versions. Filters apply only after fresh source/target admission.</summary>
    public sealed record AdjacencyRequest(
        ArticleRelationActorContext Actor,
        long IndexGeneration,
        long SourceGeneration,
        long DocumentEpoch,
        string DocumentIdentity,
        AdjacencyPermissionCoordinate Root,
        AdjacencyDirections Direction,
        ArticleRelationQueryScope Scope,
        ArticleEmbedEdgeScope EmbedScope,
        ArticleRelationKind? LinkKind = null,
        ArticleRelationRevisionKind? SourceRevisionKind = null,
        ArticleRelationTargetIdentity? ExactIncomingLinkTarget = null,
        bool IncludeLinks = true,
        bool IncludeEmbeds = true);

    /// <summary>Hard upper limits; a shared lease counts work across all depth-one/depth-two reads.</summary>
    public sealed record AdjacencyLimits(
        int Nodes = 1_000,
        int Edges = 2_000,
        int Bytes = 1_024 * 1_024,
        int IndexOperations = 4_096,
        int Milliseconds = 250);

    /// <summary>
    /// One admitted embed edge with original host bindings. It deliberately contains no admission,
    /// edge set, family digest, sibling collection or withheld count.
    /// </summary>
    public sealed record AdmittedAdjacencyEmbed(
        string HostArticleIdentity,
        string HostDocumentIdentity,
        long HostDocumentEpoch,
        long HostSourceRevision,
        long HostSourceSequence,
        long SourceGeneration,
        ArticleEmbedRelationEdge Edge,
        ArticleEmbedDependencyCoordinate Coordinate,
        ArticleEmbedDependencyReceipt? PublicationReceipt);

    /// <summary>Original link/embed domains remain separate; the index allocates no Graph frame identities.</summary>
    public sealed record AdjacencyEdge(
        ArticleRelationIndexDependencyKind DependencyKind,
        ArticleRelationRecord? Link,
        AdmittedAdjacencyEmbed? Embed);

    /// <summary>
    /// Empty unavailable is the sole failure payload. Available contains admitted items only, with
    /// no candidate total, degree, truncation flag, cursor or budget failure detail.
    /// </summary>
    public sealed record AdjacencyResult(
        bool Available,
        ImmutableArray<string> ArticleIdentities,
        ImmutableArray<AdjacencyEdge> Edges)
    {
        internal static readonly AdjacencyResult s_unavailable = new(false, [], []);
    }

    /// <summary>
    /// Index-owned, single-reader cumulative lease. Call VerifyAdjacencyBudgetAsync before publishing
    /// a multi-read Graph result; any refused read invalidates the entire lease and prior staged items.
    /// Counters and denied-candidate work are intentionally private.
    /// </summary>
    public sealed class AdjacencyBudget
    {
        internal readonly ArticleRelationIndex _owner;
        internal readonly AdjacencyLimits _limits;
        internal readonly TimeProvider _clock;
        internal readonly long _started;
        internal readonly long _realStarted;
        internal readonly HashSet<string> _nodes = new(StringComparer.Ordinal);
        internal readonly HashSet<AdjacencyEdgeKey> _edges = [];
        internal readonly HashSet<string> _families = new(StringComparer.Ordinal);
        internal readonly HashSet<AdjacencyPermissionCoordinate> _permissions = [];
        internal AdjacencyObservation? _observation;
        internal IAdjacencyAuthority? _authority;
        internal int _operations;
        internal long _bytes;
        internal bool _invalid;
        internal int _busy;

        internal AdjacencyBudget(ArticleRelationIndex owner, AdjacencyLimits limits, TimeProvider clock)
        {
            _owner = owner;
            _limits = limits;
            _clock = clock;
            _started = clock.GetTimestamp();
            _realStarted = TimeProvider.System.GetTimestamp();
        }

        internal TimeSpan Remaining(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            TimeSpan elapsed = _clock.GetElapsedTime(_started);
            TimeSpan realElapsed = TimeProvider.System.GetElapsedTime(_realStarted);
            TimeSpan remaining = TimeSpan.FromMilliseconds(_limits.Milliseconds)
                - (elapsed > realElapsed ? elapsed : realElapsed);
            Refuse(!_invalid && remaining > TimeSpan.Zero);
            return remaining;
        }

        internal void Operation(CancellationToken cancellationToken)
        {
            Remaining(cancellationToken);
            Refuse(++_operations <= _limits.IndexOperations);
        }

        internal void Charge(long bytes, CancellationToken cancellationToken)
        {
            Remaining(cancellationToken);
            Refuse(bytes >= 0 && bytes <= _limits.Bytes - _bytes);
            _bytes += bytes;
        }

        internal void Node(string identity, CancellationToken cancellationToken)
        {
            Remaining(cancellationToken);
            if (_nodes.Add(identity))
            {
                Refuse(_nodes.Count <= _limits.Nodes);
                Charge(32 + 3L * identity.Length, cancellationToken);
            }
        }
    }

    /// <summary>Creates a reusable lease with caps that callers may lower but cannot raise.</summary>
    public AdjacencyBudget CreateAdjacencyBudget(AdjacencyLimits? limits = null, TimeProvider? timeProvider = null)
    {
        limits ??= new();
        ArgumentOutOfRangeException.ThrowIfLessThan(limits.Nodes, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(limits.Nodes, 1_000);
        ArgumentOutOfRangeException.ThrowIfLessThan(limits.Edges, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(limits.Edges, 2_000);
        ArgumentOutOfRangeException.ThrowIfLessThan(limits.Bytes, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(limits.Bytes, 1_024 * 1_024);
        ArgumentOutOfRangeException.ThrowIfLessThan(limits.IndexOperations, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(limits.IndexOperations, 4_096);
        ArgumentOutOfRangeException.ThrowIfLessThan(limits.Milliseconds, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(limits.Milliseconds, 250);
        return new(this, limits, timeProvider ?? TimeProvider.System);
    }

    /// <summary>
    /// Streams precommitted article adjacency without InspectTarget/full-candidate materialization.
    /// Denied/unknown candidates are hidden before filtering, deduplication or payload charging.
    /// Source/permission drift, exhausted budgets and provider failure refuse the whole staged result.
    /// Caller cancellation throws; Graph depth and exact wire-envelope budgeting remain with Graph.
    /// </summary>
    public async Task<AdjacencyResult> ReadAdjacencyAsync(
        AdjacencyRequest request,
        IAdjacencyAuthority authority,
        AdjacencyBudget budget,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(authority);
        ArgumentNullException.ThrowIfNull(budget);
        bool entered = false;
        try
        {
            EnterBudget(budget, authority, cancellationToken);
            entered = true;
            ValidateAdjacencyRequest(request);
            await ObserveAdjacencyAsync(request, authority, budget, cancellationToken).ConfigureAwait(false);
            Refuse(await AdmitAdjacencyAsync(request.Root, authority, budget, cancellationToken).ConfigureAwait(false));
            budget.Node(request.Root.ArticleIdentity, cancellationToken);
            (ArticleRelationIndexSnapshot snapshot, AdjacencyTopology topology) = CaptureAdjacency(request, budget, cancellationToken);
            await ProbeAdjacencySourceAsync(snapshot, budget, cancellationToken).ConfigureAwait(false);
            var edges = ImmutableArray.CreateBuilder<AdjacencyEdge>();
            var nodes = new HashSet<string>(StringComparer.Ordinal) { request.Root.ArticleIdentity };
            foreach (AdjacencyCandidate candidate in EnumerateAdjacency(topology, request))
            {
                budget.Operation(cancellationToken);
                (AdjacencyPermissionCoordinate source, AdjacencyPermissionCoordinate target) = CandidateCoordinates(candidate);
                if (!await AdmitAdjacencyAsync(source, authority, budget, cancellationToken).ConfigureAwait(false)
                    || !await AdmitAdjacencyAsync(target, authority, budget, cancellationToken).ConfigureAwait(false))
                {
                    continue;
                }
                if (candidate.Embed is { } embed && !await AdmitAdjacencyAsync(new(
                    embed.HostArticleIdentity, null, embed.Admission.EdgeSet.HostSourceRevision, null,
                    null, null, embed.Edge.Scope, AdjacencyPermissionRole.EmbedHost,
                    embed.Admission.EdgeSet.HostDocument, embed.Admission.HostSourceSequence, embed.Admission.SourceGeneration),
                    authority, budget, cancellationToken).ConfigureAwait(false))
                {
                    continue;
                }
                // Fresh permission cannot silently promote stale indexed permission facts.
                Refuse(candidate.Link is { } link
                    ? link.Source.Permission == ArticleRelationPermissionState.Allowed
                        && link.Target.Permission == ArticleRelationPermissionState.Allowed
                    : candidate.Embed!.Edge.Permission == ArticleEmbedPermissionStatus.Allowed);
                if (!MatchesAdjacency(candidate, request))
                {
                    continue;
                }
                if (!budget._edges.Add(candidate.Key))
                {
                    continue;
                }
                Refuse(budget._edges.Count <= budget._limits.Edges);
                budget.Node(source.ArticleIdentity, cancellationToken);
                budget.Node(target.ArticleIdentity, cancellationToken);
                budget.Charge(CandidateBytes(candidate), cancellationToken);
                budget._families.Add(candidate.HostArticleIdentity);
                nodes.Add(source.ArticleIdentity);
                nodes.Add(target.ArticleIdentity);
                edges.Add(ProjectAdjacency(candidate));
            }
            if (snapshot.Articles.ContainsKey(request.Root.ArticleIdentity))
            {
                budget._families.Add(request.Root.ArticleIdentity);
            }
            await RevalidateAdjacencyAsync(snapshot, authority, budget, cancellationToken).ConfigureAwait(false);
            var result = new AdjacencyResult(true, nodes.Order(StringComparer.Ordinal).ToImmutableArray(), edges.ToImmutable());
            budget.Remaining(cancellationToken);
            RequireCurrent(snapshot);
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            budget._invalid = true;
            throw;
        }
        catch (Exception)
        {
            budget._invalid = true;
            return AdjacencyResult.s_unavailable;
        }
        finally
        {
            if (entered)
            {
                Volatile.Write(ref budget._busy, 0);
            }
        }
    }

    /// <summary>Final original-source and live authority check for all reads staged under one lease.</summary>
    public async Task<bool> VerifyAdjacencyBudgetAsync(
        AdjacencyBudget budget,
        IAdjacencyAuthority authority,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(budget);
        ArgumentNullException.ThrowIfNull(authority);
        bool entered = false;
        try
        {
            EnterBudget(budget, authority, cancellationToken);
            entered = true;
            Refuse(budget._observation is not null);
            ArticleRelationIndexSnapshot snapshot = Capture(budget._observation.IndexGeneration, true)!;
            await RevalidateAdjacencyAsync(snapshot, authority, budget, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            budget._invalid = true;
            throw;
        }
        catch (Exception)
        {
            budget._invalid = true;
            return false;
        }
        finally
        {
            if (entered)
            {
                Volatile.Write(ref budget._busy, 0);
            }
        }
    }

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

    /// <summary>Revalidates an exact original article family even when it has no incoming relations.</summary>
    public Task RevalidateArticleAsync(
        string articleIdentity,
        long expectedIndexGeneration,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(ArticleRelationContractValidator.Validate(new ArticleRelationTargetIdentity(
            articleIdentity, ArticleRelationTargetKind.Article, null, null)).IsValid, "article_relation_index_query_invalid");
        ArticleRelationIndexSnapshot snapshot = Capture(expectedIndexGeneration, true)!;
        Require(snapshot.Articles.ContainsKey(articleIdentity), "article_relation_index_article_unavailable");
        return RevalidateFamiliesAsync(snapshot, [articleIdentity], cancellationToken);
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

    private static void ValidateAdjacencyRequest(AdjacencyRequest request)
    {
        Refuse(ArticleRelationContractValidator.Validate(request.Actor).IsValid
            && request.IndexGeneration > 0 && request.SourceGeneration > 0 && request.DocumentEpoch > 0
            && ValidObservationVersion(request.DocumentIdentity) && (request.IncludeLinks || request.IncludeEmbeds)
            && Enum.IsDefined(request.Direction) && Enum.IsDefined(request.Scope) && Enum.IsDefined(request.EmbedScope)
            && (!request.LinkKind.HasValue || Enum.IsDefined(request.LinkKind.Value))
            && (!request.SourceRevisionKind.HasValue || Enum.IsDefined(request.SourceRevisionKind.Value))
            && request.Root is { Role: AdjacencyPermissionRole.Root, RevisionNumber: > 0 }
            && !string.IsNullOrEmpty(request.Root.RevisionIdentity) && request.Root.RevisionIdentity.Length <= 256
            && request.Root.RevisionKind.HasValue && Enum.IsDefined(request.Root.RevisionKind.Value)
            && BlockAnchorContractValidator.IsStableArticleIdentity(request.Root.ArticleIdentity)
            && request.Root.LinkTarget is { Kind: ArticleRelationTargetKind.Article }
            && request.Root.LinkTarget.ArticleIdentity == request.Root.ArticleIdentity
            && ArticleRelationContractValidator.Validate(request.Root.LinkTarget).IsValid
            && request.Root.EmbedTarget is null && request.Root.EmbedScope is null
            && (request.ExactIncomingLinkTarget is null
                || request.Direction == AdjacencyDirections.Incoming
                    && request.ExactIncomingLinkTarget.ArticleIdentity == request.Root.ArticleIdentity
                    && ArticleRelationContractValidator.Validate(request.ExactIncomingLinkTarget).IsValid)
            && (request.Scope == ArticleRelationQueryScope.Authoring
                || request.EmbedScope == ArticleEmbedEdgeScope.FrozenPublication));
    }

    private void EnterBudget(AdjacencyBudget budget, IAdjacencyAuthority authority, CancellationToken cancellationToken)
    {
        Refuse(ReferenceEquals(budget._owner, this));
        budget.Remaining(cancellationToken);
        Refuse(Interlocked.CompareExchange(ref budget._busy, 1, 0) == 0);
        if (budget._authority is not null && !ReferenceEquals(budget._authority, authority))
        {
            Volatile.Write(ref budget._busy, 0);
            Refuse(false);
        }
        budget._authority = authority;
    }

    private async Task ObserveAdjacencyAsync(
        AdjacencyRequest request,
        IAdjacencyAuthority authority,
        AdjacencyBudget budget,
        CancellationToken cancellationToken)
    {
        AdjacencyObservation? observation = await AwaitAdjacencyAsync(budget,
            token => authority.ObserveAsync(request.Actor, request.Scope, token), cancellationToken)
            .ConfigureAwait(false);
        Refuse(observation is not null && observation.Actor == _actor && request.Actor == _actor
            && observation.IndexGeneration == request.IndexGeneration && observation.SourceGeneration == request.SourceGeneration
            && observation.DocumentEpoch == request.DocumentEpoch && observation.Scope == request.Scope
            && observation.DocumentIdentity == request.DocumentIdentity
            && ValidObservationVersion(observation.PermissionRevision) && ValidObservationVersion(observation.SiteRevision)
            && ValidObservationVersion(observation.SessionRevision)
            && (budget._observation is null || budget._observation == observation));
        budget._observation ??= observation;
    }

    private static bool ValidObservationVersion(string? value) => !string.IsNullOrEmpty(value) && value.Length <= 256;

    private static async Task<bool> AdmitAdjacencyAsync(
        AdjacencyPermissionCoordinate coordinate,
        IAdjacencyAuthority authority,
        AdjacencyBudget budget,
        CancellationToken cancellationToken)
    {
        AdjacencyPermissionDecision? decision = await AwaitAdjacencyAsync(budget,
            token => authority.ReadPermissionAsync(budget._observation!, coordinate, token), cancellationToken).ConfigureAwait(false);
        Refuse(decision is not null && decision.Observation == budget._observation && decision.Coordinate == coordinate
            && Enum.IsDefined(decision.Permission));
        if (decision.Permission != ArticleRelationPermissionState.Allowed)
        {
            return false;
        }
        budget._permissions.Add(coordinate);
        return true;
    }

    private (ArticleRelationIndexSnapshot, AdjacencyTopology) CaptureAdjacency(
        AdjacencyRequest request, AdjacencyBudget budget, CancellationToken cancellationToken)
    {
        budget.Operation(cancellationToken);
        lock (_sync)
        {
            Refuse(_snapshot is not null && _adjacency is not null
                && _snapshot.IndexGeneration == request.IndexGeneration && _snapshot.SourceGeneration == request.SourceGeneration);
            return (_snapshot, _adjacency);
        }
    }

    private static IEnumerable<AdjacencyCandidate> EnumerateAdjacency(AdjacencyTopology topology, AdjacencyRequest request)
    {
        ImmutableArray<AdjacencyCandidate> incoming = request.Direction.HasFlag(AdjacencyDirections.Incoming)
            && topology.Incoming.TryGetValue(request.Root.ArticleIdentity, out var foundIncoming) ? foundIncoming : [];
        ImmutableArray<AdjacencyCandidate> outgoing = request.Direction.HasFlag(AdjacencyDirections.Outgoing)
            && topology.Outgoing.TryGetValue(request.Root.ArticleIdentity, out var foundOutgoing) ? foundOutgoing : [];
        int i = 0;
        int j = 0;
        // Two preordered lists are merged lazily. Even duplicate/self-loop candidates are admitted
        // before deduplication; no hidden candidate count determines payload truncation.
        while (i < incoming.Length || j < outgoing.Length)
        {
            if (j >= outgoing.Length || i < incoming.Length && CompareAdjacency(incoming[i], outgoing[j]) <= 0)
            {
                yield return incoming[i++];
            }
            else
            {
                yield return outgoing[j++];
            }
        }
    }

    private static (AdjacencyPermissionCoordinate Source, AdjacencyPermissionCoordinate Target) CandidateCoordinates(
        AdjacencyCandidate candidate)
    {
        if (candidate.Link is { } link)
        {
            return (new(link.Source.ArticleIdentity, link.Source.RevisionIdentity, link.Source.RevisionNumber,
                link.Source.RevisionKind, null, null, null, AdjacencyPermissionRole.Source),
                new(link.Target.TargetIdentity!.ArticleIdentity, link.Target.RevisionIdentity, link.Target.RevisionNumber,
                    link.Target.RevisionKind, link.Target.TargetIdentity, null, null, AdjacencyPermissionRole.Target));
        }
        ArticleRelationIndexEmbedEntry embed = candidate.Embed!;
        return (new(embed.Edge.OwnerPortableArticleIdentity, null, embed.Edge.OwnerRevision, null,
            null, null, embed.Edge.Scope, AdjacencyPermissionRole.Source, embed.Admission.EdgeSet.HostDocument,
            embed.Admission.HostSourceSequence, embed.Admission.SourceGeneration),
            new(embed.Edge.Target.PortableArticleIdentity, embed.Coordinate.TargetVersionIdentity,
                embed.Edge.ResolvedRevision, null, null, embed.Edge.Target, embed.Edge.Scope, AdjacencyPermissionRole.Target,
                embed.Admission.EdgeSet.HostDocument, embed.Admission.HostSourceSequence, embed.Admission.SourceGeneration));
    }

    private static bool MatchesAdjacency(AdjacencyCandidate candidate, AdjacencyRequest request)
    {
        if (candidate.Link is { } link)
        {
            return request.IncludeLinks && link.Visibility.QueryScope == request.Scope
                && (!request.LinkKind.HasValue || request.LinkKind == link.Kind)
                && (!request.SourceRevisionKind.HasValue || request.SourceRevisionKind == link.Source.RevisionKind)
                && (request.ExactIncomingLinkTarget is null || request.ExactIncomingLinkTarget == link.Target.TargetIdentity)
                && (request.Scope != ArticleRelationQueryScope.CurrentPublicPublication
                    || link.Source.RevisionKind == ArticleRelationRevisionKind.Published
                        && link.Target.RevisionKind == ArticleRelationRevisionKind.Published
                        && link.Source.Lifecycle == ArticleRelationLifecycleState.Published
                        && link.Target.Lifecycle == ArticleRelationLifecycleState.Published);
        }
        // Link-specific revision/kind/exact-target filters do not implicitly reinterpret embed facts.
        return request.IncludeEmbeds && candidate.Embed!.Edge.Scope == request.EmbedScope
            && (request.Scope != ArticleRelationQueryScope.CurrentPublicPublication
                || candidate.Embed.Edge.Visibility == ArticleEmbedVisibilityStatus.Public
                    && candidate.Embed.Edge.Lifecycle == ArticleEmbedLifecycleStatus.Published);
    }

    private static AdjacencyEdge ProjectAdjacency(AdjacencyCandidate candidate)
    {
        if (candidate.Link is { } link)
        {
            return new(ArticleRelationIndexDependencyKind.Link, link, null);
        }
        ArticleRelationIndexEmbedEntry embed = candidate.Embed!;
        ArticleEmbedRelationEdgeSet set = embed.Admission.EdgeSet;
        return new(ArticleRelationIndexDependencyKind.Embed, null, new(embed.HostArticleIdentity,
            set.HostDocument.Id, set.HostDocument.Epoch, set.HostSourceRevision,
            embed.Admission.HostSourceSequence, embed.Admission.SourceGeneration,
            embed.Edge, embed.Coordinate, embed.PublicationReceipt));
    }

    private async Task ProbeAdjacencySourceAsync(
        ArticleRelationIndexSnapshot snapshot, AdjacencyBudget budget, CancellationToken cancellationToken)
    {
        ArticleRelationIndexSourcePage page = await AwaitAdjacencyAsync(budget,
            token => _source.ReadAsync(_actor, null, 1, snapshot.SourceGeneration, token), cancellationToken).ConfigureAwait(false);
        ValidatePage(page, snapshot.SourceGeneration, 1);
        RequireCurrent(snapshot);
    }

    private async Task RevalidateAdjacencyAsync(
        ArticleRelationIndexSnapshot snapshot,
        IAdjacencyAuthority authority,
        AdjacencyBudget budget,
        CancellationToken cancellationToken)
    {
        await ProbeAdjacencySourceAsync(snapshot, budget, cancellationToken).ConfigureAwait(false);
        foreach (string identity in budget._families.Order(StringComparer.Ordinal))
        {
            ArticleRelationIndexArticleRead read = await AwaitAdjacencyAsync(budget,
                token => _source.ReadArticleAsync(_actor, identity, snapshot.SourceGeneration, token), cancellationToken)
                .ConfigureAwait(false);
            ArticleRelationIndexArticle? held = null;
            Refuse(read.Actor == _actor && read.SourceGeneration == snapshot.SourceGeneration
                && snapshot.Articles.TryGetValue(identity, out held));
            CompareAdjacencyFamily(held!, read.Article, budget, cancellationToken);
        }
        foreach (AdjacencyPermissionCoordinate coordinate in budget._permissions.ToArray())
        {
            Refuse(await AdmitAdjacencyAsync(coordinate, authority, budget, cancellationToken).ConfigureAwait(false));
        }
        AdjacencyObservation? final = await AwaitAdjacencyAsync(budget, token => authority.ObserveAsync(
            _actor, budget._observation!.Scope, token), cancellationToken).ConfigureAwait(false);
        Refuse(final == budget._observation);
        await ProbeAdjacencySourceAsync(snapshot, budget, cancellationToken).ConfigureAwait(false);
        budget.Remaining(cancellationToken);
        RequireCurrent(snapshot);
    }

    private static void CompareAdjacencyFamily(
        ArticleRelationIndexArticle held,
        ArticleRelationIndexArticle current,
        AdjacencyBudget budget,
        CancellationToken cancellationToken)
    {
        budget.Operation(cancellationToken);
        Refuse(current is not null && current.ArticleIdentity == held.ArticleIdentity && current.SourceSequence == held.SourceSequence
            && !current.Sets.IsDefault && current.Sets.Length == held.Sets.Length
            && !current.Embeds.IsDefault && current.Embeds.Length == held.Embeds.Length);
        // Canonical producer may return sets/records in a different order. Lookups are bounded
        // before allocation; full fact parity avoids trusting only a caller-supplied digest.
        var remainingSets = new Dictionary<(ArticleRelationRevisionKind, string), ArticleRelationSet>();
        foreach (ArticleRelationSet set in held.Sets)
        {
            budget.Operation(cancellationToken);
            remainingSets.Add((set.Source.RevisionKind, set.Source.RevisionIdentity), set);
        }
        foreach (ArticleRelationSet set in current.Sets)
        {
            budget.Operation(cancellationToken);
            ArticleRelationSet? expected = null;
            Refuse(set is not null && set.Source is not null && set.Relations is not null
                && remainingSets.Remove((set.Source.RevisionKind, set.Source.RevisionIdentity), out expected)
                && set.Relations.Count == expected.Relations.Count);
            budget.Charge(256 + SourceBytes(set.Source), cancellationToken);
            Refuse(set.Schema == expected.Schema && set.SchemaVersion == expected.SchemaVersion
                && set.Source == expected.Source && ArticleRelationDigest.IsSha256(set.SetDigest));
            var records = new Dictionary<string, ArticleRelationRecord>(StringComparer.Ordinal);
            foreach (ArticleRelationRecord record in expected.Relations)
            {
                budget.Operation(cancellationToken);
                records.Add(record.RelationIdentity, record);
            }
            foreach (ArticleRelationRecord record in set.Relations)
            {
                budget.Operation(cancellationToken);
                Refuse(record is not null);
                budget.Charge(LinkBytes(record), cancellationToken);
                Refuse(records.Remove(record.RelationIdentity, out ArticleRelationRecord? original) && record == original);
            }
            foreach (ArticleRelationRecord record in set.Relations)
            {
                budget.Operation(cancellationToken);
            }
            // The sole set digest is order-sensitive. Validate the producer's real order after
            // bounded full-fact comparison rather than mistaking index ordering for source drift.
            Refuse(ArticleRelationDigest.ComputeSet(set) == set.SetDigest);
            budget.Remaining(cancellationToken);
        }
        // Admission objects have private canonical factories and immutable copied edge/coordinate
        // arrays. Charge each original edge/coordinate before the existing binding verifier runs.
        var remainingEmbeds = new Dictionary<(ArticleEmbedEdgeScope, string, long, long), ArticleRelationIndexEmbedAdmission>();
        foreach (ArticleRelationIndexEmbedAdmission admission in held.Embeds)
        {
            budget.Operation(cancellationToken);
            var set = admission.EdgeSet;
            remainingEmbeds.Add((set.Scope, set.HostDocument.Id, set.HostDocument.Epoch, set.HostSourceRevision), admission);
        }
        foreach (ArticleRelationIndexEmbedAdmission admission in current.Embeds)
        {
            budget.Operation(cancellationToken);
            Refuse(admission is not null);
            var set = admission.EdgeSet;
            ArticleRelationIndexEmbedAdmission? expected = null;
            Refuse(remainingEmbeds.Remove((set.Scope, set.HostDocument.Id, set.HostDocument.Epoch, set.HostSourceRevision),
                out expected)
                && set.Edges.Count == expected.EdgeSet.Edges.Count && admission.Coordinates.Length == expected.Coordinates.Length
                && admission.DependencyReceipts.Length == expected.DependencyReceipts.Length);
            foreach (ArticleEmbedRelationEdge edge in set.Edges)
            {
                budget.Operation(cancellationToken);
                budget.Charge(EmbedBytes(edge), cancellationToken);
            }
            foreach (ArticleEmbedDependencyCoordinate coordinate in admission.Coordinates)
            {
                budget.Operation(cancellationToken);
                budget.Charge(CoordinateBytes(coordinate), cancellationToken);
            }
            foreach (ArticleEmbedDependencyReceipt receipt in admission.DependencyReceipts)
            {
                budget.Operation(cancellationToken);
                budget.Charge(512 + CoordinateBytes(receipt.Coordinate), cancellationToken);
            }
            Refuse(expected.SameBinding(admission));
        }
    }

    private static async Task<T> AwaitAdjacencyAsync<T>(
        AdjacencyBudget budget, Func<CancellationToken, Task<T>> read, CancellationToken cancellationToken)
    {
        budget.Operation(cancellationToken);
        using var deadline = TimeoutCancellationScope.Create(budget.Remaining(cancellationToken), cancellationToken);
        T result = await read(deadline.Token).WaitAsync(deadline.Token).ConfigureAwait(false);
        budget.Remaining(cancellationToken);
        return result;
    }

    // Conservative UTF-8 upper bound, including original metadata and fixed scalar/envelope
    // allowance. Length checks happen before potentially large equality/hash work. The same byte
    // lease pays original-source comparison work as well as emitted payload; Graph wire framing
    // has an additional owner-side budget and cannot infer exact serialized bytes from this bound.
    private static long TextBytes(params string?[] values)
        => values.Sum(static value => 3L * (value?.Length ?? 0));

    private static long TargetBytes(ArticleRelationTargetIdentity? target)
        => target is null ? 0 : TextBytes(target.ArticleIdentity, target.HeadingIdentity, target.BlockAnchorIdentity);

    private static long EmbedTargetBytes(ArticleEmbedTargetIdentity target)
        => TextBytes(target.PortableArticleIdentity, target.HeadingIdentity, target.BlockAnchor);

    private static long SourceBytes(ArticleRelationSourceFacts source)
        => TextBytes(source.ArticleIdentity, source.RevisionIdentity, source.ContentDigest, source.SourceActor.ActorIdentity,
            source.SourceActor.SiteIdentity, source.SourceActor.PermissionContextDigest);

    private static long LinkBytes(ArticleRelationRecord record)
        => 512 + SourceBytes(record.Source) + TargetBytes(record.Target.TargetIdentity)
            + TextBytes(record.Schema, record.RelationIdentity, record.RecordDigest, record.Target.RevisionIdentity,
                record.Occurrence.LinkText, record.Occurrence.First.MatchedText, record.Occurrence.Last.MatchedText,
                record.Visibility.SourceActor.ActorIdentity, record.Visibility.SourceActor.SiteIdentity,
                record.Visibility.SourceActor.PermissionContextDigest, record.Visibility.QueryActor.ActorIdentity,
                record.Visibility.QueryActor.SiteIdentity, record.Visibility.QueryActor.PermissionContextDigest,
                record.Visibility.PermissionPolicyDigest);

    private static long EmbedBytes(ArticleEmbedRelationEdge edge)
        => 512 + EmbedTargetBytes(edge.Target) + TextBytes(edge.Schema, edge.EdgeIdentity,
            edge.OwnerPortableArticleIdentity, edge.Directive.ParserContract, edge.Directive.TargetToken,
            edge.DependencyDigest, edge.EdgeDigest);

    private static long CoordinateBytes(ArticleEmbedDependencyCoordinate coordinate)
        => 128 + EmbedTargetBytes(coordinate.Target) + TextBytes(coordinate.TargetVersionIdentity,
            coordinate.ProjectionIdentity, coordinate.ProjectionDigest, coordinate.DependencyDigest);

    private static long CandidateBytes(AdjacencyCandidate candidate)
        => candidate.Link is { } link ? LinkBytes(link) : EmbedBytes(candidate.Embed!.Edge)
            + CoordinateBytes(candidate.Embed.Coordinate)
            + TextBytes(candidate.HostArticleIdentity, candidate.Embed.Admission.EdgeSet.HostDocument.Id)
            + (candidate.Embed.PublicationReceipt is null ? 128 : 640 + CoordinateBytes(candidate.Embed.PublicationReceipt.Coordinate));

    private static void AddAdjacency(Dictionary<string, List<AdjacencyCandidate>> lookup, string identity, AdjacencyCandidate candidate)
    {
        if (!lookup.TryGetValue(identity, out List<AdjacencyCandidate>? candidates))
        {
            candidates = [];
            lookup.Add(identity, candidates);
        }
        candidates.Add(candidate);
    }

    private static ImmutableDictionary<string, ImmutableArray<AdjacencyCandidate>> FreezeAdjacency(
        Dictionary<string, List<AdjacencyCandidate>> lookup)
        => lookup.ToImmutableDictionary(static pair => pair.Key,
            static pair => pair.Value.Order(Comparer<AdjacencyCandidate>.Create(CompareAdjacency)).ToImmutableArray(), StringComparer.Ordinal);

    private static int CompareAdjacency(AdjacencyCandidate left, AdjacencyCandidate right)
    {
        int kind = left.Key.Kind.CompareTo(right.Key.Kind);
        if (kind != 0)
        {
            return kind;
        }
        int host = StringComparer.Ordinal.Compare(left.HostArticleIdentity, right.HostArticleIdentity);
        if (host != 0)
        {
            return host;
        }
        int identity = StringComparer.Ordinal.Compare(left.Key.Identity, right.Key.Identity);
        if (identity != 0 || left.Embed is null || right.Embed is null)
        {
            return identity;
        }
        int scope = left.Embed.Edge.Scope.CompareTo(right.Embed.Edge.Scope);
        if (scope != 0)
        {
            return scope;
        }
        int document = StringComparer.Ordinal.Compare(left.Key.Document, right.Key.Document);
        if (document != 0)
        {
            return document;
        }
        int epoch = left.Key.Epoch.CompareTo(right.Key.Epoch);
        return epoch != 0 ? epoch : left.Key.Revision.CompareTo(right.Key.Revision);
    }

    private static void Refuse([DoesNotReturnIf(false)] bool condition)
    {
        if (!condition)
        {
            throw new AdjacencyUnavailableException();
        }
    }

    private sealed class AdjacencyUnavailableException : InvalidOperationException
    {
    }

    internal sealed record AdjacencyEdgeKey(
        ArticleRelationIndexDependencyKind Kind, string Host, string Identity, string? Document, long Epoch, long Revision);

    private sealed record AdjacencyCandidate(
        string HostArticleIdentity, ArticleRelationRecord? Link, ArticleRelationIndexEmbedEntry? Embed)
    {
        public AdjacencyEdgeKey Key => Link is { } link
            ? new(ArticleRelationIndexDependencyKind.Link, HostArticleIdentity, link.RelationIdentity, null, 0, 0)
            : new(ArticleRelationIndexDependencyKind.Embed, HostArticleIdentity, Embed!.Edge.EdgeIdentity,
                Embed.Admission.EdgeSet.HostDocument.Id, Embed.Admission.EdgeSet.HostDocument.Epoch,
                Embed.Admission.EdgeSet.HostSourceRevision);
    }

    private sealed record AdjacencyTopology(
        ImmutableDictionary<string, ImmutableArray<AdjacencyCandidate>> Incoming,
        ImmutableDictionary<string, ImmutableArray<AdjacencyCandidate>> Outgoing);

    private sealed record PreparedSnapshot(ArticleRelationIndexSnapshot Snapshot, AdjacencyTopology Topology);

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
        PreparedSnapshot next,
        CancellationToken cancellationToken)
    {
        lock (_sync)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Require(ReferenceEquals(_snapshot, previous), "article_relation_index_generation_stale");
            _snapshot = next.Snapshot;
            _adjacency = next.Topology;
            return next.Snapshot;
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

    private PreparedSnapshot BuildSnapshot(
        ImmutableSortedDictionary<string, ArticleRelationIndexArticle> articles,
        long expectedIndexGeneration,
        long sourceGeneration,
        CancellationToken cancellationToken)
    {
        Require(expectedIndexGeneration < long.MaxValue, "article_relation_index_generation_exhausted");
        var budget = new StorageBudget();
        var targets = new Dictionary<ArticleRelationTargetIdentity, List<ArticleRelationRecord>>();
        var embedTargets = new Dictionary<ArticleEmbedTargetIdentity, List<ArticleRelationIndexEmbedEntry>>();
        var incoming = new Dictionary<string, List<AdjacencyCandidate>>(StringComparer.Ordinal);
        var outgoing = new Dictionary<string, List<AdjacencyCandidate>>(StringComparer.Ordinal);
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
                    var candidate = new AdjacencyCandidate(article.ArticleIdentity, record, null);
                    AddAdjacency(incoming, target.ArticleIdentity, candidate);
                    AddAdjacency(outgoing, record.Source.ArticleIdentity, candidate);
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
                    var entry = new ArticleRelationIndexEmbedEntry(article.ArticleIdentity, admission, edge, admission.Coordinates[i], receipt);
                    entries.Add(entry);
                    var candidate = new AdjacencyCandidate(article.ArticleIdentity, null, entry);
                    AddAdjacency(incoming, edge.Target.PortableArticleIdentity, candidate);
                    AddAdjacency(outgoing, edge.OwnerPortableArticleIdentity, candidate);
                }
            }
        }
        var snapshot = new ArticleRelationIndexSnapshot(_actor, expectedIndexGeneration + 1, sourceGeneration, articles,
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
        return new(snapshot, new(FreezeAdjacency(incoming), FreezeAdjacency(outgoing)));
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
