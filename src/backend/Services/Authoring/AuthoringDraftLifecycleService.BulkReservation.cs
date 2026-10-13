using System.Collections.Immutable;
using System.Data;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Articles.Bulk;

using Npgsql;

using NpgsqlTypes;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class AuthoringDraftLifecycleService
{
    private const int BulkDraftLimit = 10_000;
    private const int BulkDraftByteLimit = 16 * 1024 * 1024;
    private readonly ConditionalWeakTable<BulkDraftReservation, BulkDraftState> _bulkDraftReservations = new();
    private static readonly JsonSerializerOptions s_bulkDraftRightsOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 8
    };

    /// <summary>Opaque persistence reservation only; not live editor, permission, commit or zero-write admission.</summary>
    internal sealed class BulkDraftReservation;

    /// <summary>Actual persisted coordinates/content identities; never editor/unsaved-state admission.</summary>
    internal sealed record BulkDraftLockedRow(long Id, int ArticleId, long OwnerAdminPrincipalId,
        string DraftKey, long? BaseRevisionId, long ServerRevision, string? ClientRevision,
        DateTime UpdatedAt, string PersistedRowDigest);

    internal sealed record BulkDraftLockedFacts(ImmutableArray<int> OrderedArticleIds,
        ImmutableArray<BulkDraftLockedRow> Drafts);

    private sealed record LockedArticle(int Id, long RevisionId, int RevisionNo, ArticleStatus Status,
        bool IsDeleted, DateTime? ScheduledPublishAt);

    private sealed class BulkDraftState(NpgsqlTransaction transaction, ArticleBulkExecutionRequest request,
        ImmutableArray<ArticleBulkPlanItem> frozenItems, Dictionary<int, LockedArticle> articles, List<ArticleDraft> drafts)
    {
        internal readonly NpgsqlTransaction _transaction = transaction;
        internal readonly ArticleBulkExecutionRequest _request = request;
        internal readonly ImmutableArray<ArticleBulkPlanItem> _frozenItems = frozenItems;
        internal readonly Dictionary<int, LockedArticle> _articles = articles;
        internal readonly List<ArticleDraft> _drafts = drafts;
        internal int _useState;
        internal long _packageBytes;
    }

    /// <summary>
    /// Locks persisted article/draft state in the caller's exact original transaction. The original
    /// group owner must separately admit live actor/session/site/policy and opaque preflight revisions.
    /// </summary>
    internal async Task<BulkDraftReservation> LockBulkDraftsAsync(
        NpgsqlTransaction originalTransaction, ArticleBulkExecutionRequest request, ArticleBulkPlan plan,
        ArticleBulkPlanAuthority plans, CancellationToken cancellationToken)
    {
        RequireBulkDraftTransaction(originalTransaction);
        ImmutableArray<ArticleBulkPlanItem> frozen = [.. plan.Items];
        ValidateBulkDraftBinding(request, plan, plans, frozen);
        long owner = long.Parse(request.Actor.UserId, CultureInfo.InvariantCulture);
        int[] ids = [.. frozen.Select(static item => int.Parse(item.ArticleId, CultureInfo.InvariantCulture)).Order()];
        Dictionary<int, LockedArticle> articles = await ReadBulkArticlesAsync(originalTransaction, ids, true, cancellationToken)
            .ConfigureAwait(false);
        if (articles.Count != ids.Length)
            throw BulkDraftFailure("article_missing");
        // Row locks alone do not stop Save/Create from inserting a new draft into this frozen set.
        // This ordinary PostgreSQL table write fence covers every existing INSERT/UPDATE/DELETE owner.
        using (var fence = new NpgsqlCommand("LOCK TABLE article_draft IN SHARE ROW EXCLUSIVE MODE;",
            RequireBulkDraftTransaction(originalTransaction), originalTransaction))
            await fence.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        RequireBulkDraftTransaction(originalTransaction);
        List<ArticleDraft> drafts = await ReadBulkDraftsAsync(originalTransaction, ids, owner, cancellationToken).ConfigureAwait(false);
        RequireBulkDraftTransaction(originalTransaction);
        cancellationToken.ThrowIfCancellationRequested();
        var reservation = new BulkDraftReservation();
        _bulkDraftReservations.Add(reservation, new(originalTransaction, request, frozen, articles, drafts));
        return reservation;
    }

    /// <summary>
    /// Reacquires actual original article/draft locks, rereads the full persisted snapshot and
    /// checks every persisted draft against real current revision/source/rights before mutation.
    /// Metadata is returned in the original frozen order. It does not observe live editor state.
    /// Failure/cancellation poisons the original reservation; native release belongs to its caller.
    /// </summary>
    internal async Task<BulkDraftLockedFacts> ReadLockedBulkDraftFactsAsync(BulkDraftReservation reservation,
        NpgsqlTransaction originalTransaction, ArticleBulkExecutionRequest request, ArticleBulkPlan plan,
        ArticleBulkPlanAuthority plans, CancellationToken cancellationToken)
    {
        if (!_bulkDraftReservations.TryGetValue(reservation, out BulkDraftState? state)
            || !ReferenceEquals(state._transaction, originalTransaction) || !ReferenceEquals(state._request, request)
            || Interlocked.CompareExchange(ref state._useState, 4, 0) != 0)
            throw BulkDraftFailure("reservation_unavailable");
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            ImmutableArray<ArticleBulkPlanItem> frozen = [.. plan.Items];
            ValidateBulkDraftBinding(request, plan, plans, frozen);
            if (!frozen.SequenceEqual(state._frozenItems))
                throw BulkDraftFailure("frozen_set_changed");
            int[] ordered = [.. frozen.Select(static item => int.Parse(item.ArticleId, CultureInfo.InvariantCulture))];
            int[] ids = [.. ordered.Order()];
            Dictionary<int, LockedArticle> articles = await ReadBulkArticlesAsync(originalTransaction, ids, true, cancellationToken)
                .ConfigureAwait(false);
            if (articles.Count != state._articles.Count || state._articles.Any(pair =>
                !articles.TryGetValue(pair.Key, out LockedArticle? actual) || actual != pair.Value))
                throw BulkDraftFailure("article_changed");
            // Reacquire the original write fence rather than assuming an earlier lock survives a caller savepoint.
            using (var fence = new NpgsqlCommand("LOCK TABLE article_draft IN SHARE ROW EXCLUSIVE MODE;",
                RequireBulkDraftTransaction(originalTransaction), originalTransaction))
                await fence.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            List<ArticleDraft> current = await ReadBulkDraftsAsync(originalTransaction, ids,
                long.Parse(request.Actor.UserId, CultureInfo.InvariantCulture), cancellationToken).ConfigureAwait(false);
            if (JsonSerializer.Serialize(current) != JsonSerializer.Serialize(state._drafts))
                throw BulkDraftFailure("draft_changed");
            var rows = ImmutableArray.CreateBuilder<BulkDraftLockedRow>(current.Count);
            ILookup<int?, ArticleDraft> byArticle = current.ToLookup(static draft => draft.ArticleId);
            // This invocation has its own bounded, transient package read set. The later original CAS
            // keeps its separate full before/after budget, not a cumulative repeated-observation counter.
            state._packageBytes = 0;
            try
            {
                foreach (int id in ordered)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    ArticleRevision revision = await ReadBulkRevisionAsync(state, articles[id], cancellationToken).ConfigureAwait(false);
                    ArticleRightsSnapshot rights = await ReadBulkRightsAsync(originalTransaction, articles[id], cancellationToken).ConfigureAwait(false);
                    foreach (ArticleDraft draft in byArticle[id])
                    {
                        if (!BulkDraftMatchesRevision(draft, revision, articles[id].Status, articles[id].ScheduledPublishAt)
                            || !BulkDraftRightsMatch(draft.RightsJson, rights))
                            throw BulkDraftFailure("draft_not_safe_before_mutation");
                        rows.Add(new(draft.Id, id, draft.OwnerAdminPrincipalId, draft.DraftKey, draft.BaseRevisionId,
                            draft.ServerRevision, draft.ClientRevision, draft.UpdatedAt, ArticleBulkDigest.Of(draft)));
                    }
                }
            }
            finally
            {
                // Complete the read budget cleanup before allowing the reservation to be reused.
                state._packageBytes = 0;
            }
            RequireBulkDraftTransaction(originalTransaction);
            cancellationToken.ThrowIfCancellationRequested();
            var facts = new BulkDraftLockedFacts([.. ordered], rows.ToImmutable());
            Volatile.Write(ref state._useState, 0);
            return facts;
        }
        catch
        {
            Volatile.Write(ref state._useState, 3);
            throw;
        }
    }

    /// <summary>
    /// Stages one whole-set metadata-only draft CAS after actual canonical writer results. All
    /// immutable packages and draft bytes must be safe before any draft update. Failure poisons
    /// this reservation and requires the original owner to abort/observe its transaction; never zero-write.
    /// No transaction or connection lifecycle, audit/commit receipt or availability is owned here.
    /// </summary>
    internal async Task StageBulkDraftMetadataCasAsync(BulkDraftReservation reservation,
        IReadOnlyList<ArticleLifecycleTransitionWriter.Result> results, DateTime updatedAtUtc,
        CancellationToken cancellationToken)
    {
        if (!_bulkDraftReservations.TryGetValue(reservation, out BulkDraftState? state)
            || Interlocked.CompareExchange(ref state._useState, 1, 0) != 0)
            throw BulkDraftFailure("reservation_unavailable");
        try
        {
            RequireBulkDraftTransaction(state._transaction);
            ArticleLifecycleTransitionWriter.Result[] frozenResults = [.. results];
            if (updatedAtUtc.Kind != DateTimeKind.Utc || frozenResults.Length != state._articles.Count
                || frozenResults.Select(static result => result.ArticleId).Distinct().Count() != frozenResults.Length)
                throw BulkDraftFailure("result_set_invalid");
            int[] ids = [.. state._articles.Keys.Order()];
            long owner = long.Parse(state._request.Actor.UserId, CultureInfo.InvariantCulture);
            List<ArticleDraft> currentDrafts = await ReadBulkDraftsAsync(state._transaction, ids, owner, cancellationToken).ConfigureAwait(false);
            if (JsonSerializer.Serialize(currentDrafts) != JsonSerializer.Serialize(state._drafts))
                throw BulkDraftFailure("draft_changed");
            Dictionary<int, LockedArticle> currentArticles = await ReadBulkArticlesAsync(state._transaction, ids, false, cancellationToken)
                .ConfigureAwait(false);
            var updates = new List<ArticleDraft>();
            ILookup<int?, ArticleDraft> draftsByArticle = state._drafts.ToLookup(static draft => draft.ArticleId);
            foreach (ArticleLifecycleTransitionWriter.Result result in frozenResults)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!state._articles.TryGetValue(result.ArticleId, out LockedArticle? beforeArticle)
                    || !currentArticles.TryGetValue(result.ArticleId, out LockedArticle? afterArticle)
                    || !MatchesBulkCoordinates(beforeArticle, result.Before) || !MatchesBulkCoordinates(afterArticle, result.After))
                    throw BulkDraftFailure("writer_coordinates_changed");
                await RequireBulkWriterRowsAsync(state._transaction, state._request.Actor.UserId, result, cancellationToken).ConfigureAwait(false);
                ArticleRevision before = await ReadBulkRevisionAsync(state, beforeArticle, cancellationToken).ConfigureAwait(false);
                ArticleRevision after = await ReadBulkRevisionAsync(state, afterArticle, cancellationToken).ConfigureAwait(false);
                if (!SameBulkDraftContent(before, after))
                    throw BulkDraftFailure("revision_content_changed");
                ArticleRightsSnapshot beforeRights = await ReadBulkRightsAsync(state._transaction, beforeArticle, cancellationToken).ConfigureAwait(false);
                ArticleRightsSnapshot afterRights = await ReadBulkRightsAsync(state._transaction, afterArticle, cancellationToken).ConfigureAwait(false);
                if (BulkRightsModel(beforeRights) != BulkRightsModel(afterRights))
                    throw BulkDraftFailure("rights_changed");
                await RequireBulkResponsibilityPreservedAsync(state._transaction, beforeArticle, afterArticle, cancellationToken).ConfigureAwait(false);
                foreach (ArticleDraft draft in draftsByArticle[result.ArticleId])
                {
                    if (!BulkDraftMatchesRevision(draft, before, beforeArticle.Status, beforeArticle.ScheduledPublishAt)
                        || !BulkDraftRightsMatch(draft.RightsJson, beforeRights) || draft.ServerRevision == long.MaxValue)
                        throw BulkDraftFailure("draft_not_safe_to_advance");
                    // Preserve every user field and exact rights/client/source bytes. Change only canonical coordinates.
                    ArticleDraft candidate = JsonSerializer.Deserialize<ArticleDraft>(JsonSerializer.Serialize(draft))!;
                    candidate.BaseRevisionId = after.Id;
                    candidate.Status = afterArticle.Status;
                    candidate.ScheduledPublishAt = afterArticle.ScheduledPublishAt;
                    candidate.UpdatedAt = new DateTime(updatedAtUtc.Ticks - updatedAtUtc.Ticks % 10, DateTimeKind.Unspecified);
                    updates.Add(candidate);
                }
            }
            foreach (ArticleDraft candidate in updates)
            {
                cancellationToken.ThrowIfCancellationRequested();
                RequireBulkDraftTransaction(state._transaction);
                // Reuse the actual original CAS primitive; no standalone Save/Discard transaction or normalization.
                int affected = await UpdateDraftWithCasAsync(candidate, candidate.ServerRevision).ConfigureAwait(false);
                RequireBulkDraftTransaction(state._transaction);
                if (affected != 1)
                    throw BulkDraftFailure("cas_conflict");
            }
            List<ArticleDraft> readback = await ReadBulkDraftsAsync(state._transaction, ids, owner, cancellationToken).ConfigureAwait(false);
            Dictionary<long, ArticleDraft> readbackById = readback.ToDictionary(static draft => draft.Id);
            foreach (ArticleDraft candidate in updates)
            {
                readbackById.TryGetValue(candidate.Id, out ArticleDraft? actual);
                candidate.ServerRevision++;
                if (actual is null || JsonSerializer.Serialize(actual) != JsonSerializer.Serialize(candidate))
                    throw BulkDraftFailure("cas_readback_changed");
            }
            if (readback.Count != state._drafts.Count)
                throw BulkDraftFailure("cas_readback_set_changed");
            RequireBulkDraftTransaction(state._transaction);
            cancellationToken.ThrowIfCancellationRequested();
            state._useState = 2;
        }
        catch
        {
            state._useState = 3;
            throw;
        }
    }

    private NpgsqlConnection RequireBulkDraftTransaction(NpgsqlTransaction transaction)
    {
        if (!ReferenceEquals(db.Ado.Transaction, transaction) || db.Ado.Connection is not NpgsqlConnection connection
            || !ReferenceEquals(transaction.Connection, connection) || connection.State != ConnectionState.Open)
            throw BulkDraftFailure("original_transaction_required");
        return connection;
    }

    private async Task<Dictionary<int, LockedArticle>> ReadBulkArticlesAsync(NpgsqlTransaction transaction,
        int[] ids, bool lockRows, CancellationToken cancellationToken)
    {
        var articles = new Dictionary<int, LockedArticle>();
        using var command = new NpgsqlCommand("""
            SELECT a.id,a.current_revision_id,r.revision_no,a.status,a.isdeleted,a.scheduled_publish_at
            FROM article a JOIN article_revision r ON r.id=a.current_revision_id AND r.article_id=a.id
            WHERE a.id=ANY(@Ids) ORDER BY a.id
            """ + (lockRows ? " FOR UPDATE OF a;" : ";"), RequireBulkDraftTransaction(transaction), transaction);
        command.Parameters.AddWithValue("Ids", NpgsqlDbType.Array | NpgsqlDbType.Integer, ids);
        using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            RequireBulkDraftTransaction(transaction);
            articles.Add(reader.GetInt32(0), new(reader.GetInt32(0), reader.GetInt64(1), reader.GetInt32(2),
                (ArticleStatus)reader.GetInt32(3), reader.GetBoolean(4), reader.IsDBNull(5) ? null : reader.GetDateTime(5)));
        }
        RequireBulkDraftTransaction(transaction);
        cancellationToken.ThrowIfCancellationRequested();
        return articles;
    }

    private async Task<List<ArticleDraft>> ReadBulkDraftsAsync(NpgsqlTransaction transaction, int[] ids, long owner,
        CancellationToken cancellationToken)
    {
        using (var budget = new NpgsqlCommand("""
            SELECT count(*),coalesce(sum(octet_length(row_to_json(d)::text)),0),
                   count(*) FILTER (WHERE owner_admin_principal_id<>@Owner)
            FROM article_draft d WHERE article_id=ANY(@Ids);
            """, RequireBulkDraftTransaction(transaction), transaction))
        {
            budget.Parameters.AddWithValue("Ids", NpgsqlDbType.Array | NpgsqlDbType.Integer, ids);
            budget.Parameters.AddWithValue("Owner", owner);
            using NpgsqlDataReader reader = await budget.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            RequireBulkDraftTransaction(transaction);
            if (reader.GetInt64(0) > BulkDraftLimit || reader.GetInt64(1) > BulkDraftByteLimit || reader.GetInt64(2) != 0)
                throw BulkDraftFailure("draft_set_not_available");
        }
        RequireBulkDraftTransaction(transaction);
        List<ArticleDraft> drafts = await db.Queryable<ArticleDraft>()
            .Where(draft => draft.ArticleId.HasValue && ids.Contains(draft.ArticleId.Value))
            .OrderBy(draft => draft.Id).Take(BulkDraftLimit + 1).ToListAsync(cancellationToken).ConfigureAwait(false);
        RequireBulkDraftTransaction(transaction);
        if (drafts.Count > BulkDraftLimit || drafts.Any(draft => draft.OwnerAdminPrincipalId != owner)
            || Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(drafts)) > BulkDraftByteLimit)
            throw BulkDraftFailure("draft_set_not_available");
        return drafts;
    }

    private async Task<ArticleRevision> ReadBulkRevisionAsync(BulkDraftState state, LockedArticle article,
        CancellationToken cancellationToken)
    {
        NpgsqlTransaction transaction = state._transaction;
        using (var budget = new NpgsqlCommand("""
            SELECT octet_length(row_to_json(r)::text)::bigint + octet_length(b.markdown_content)
                + coalesce((SELECT octet_length(row_to_json(p)::text) FROM article_rights_snapshot p
                    WHERE p.article_id=r.article_id AND p.article_revision_id=r.id LIMIT 1),0)
                + coalesce((SELECT octet_length(row_to_json(p)::text) FROM article_responsibility_snapshot p
                    WHERE p.article_id=r.article_id AND p.article_revision_id=r.id
                    ORDER BY p.responsibility_version DESC,p.id DESC LIMIT 1),0)
            FROM article_revision r JOIN article_revision_content_block b ON b.id=r.content_block_id
            WHERE r.id=@RevisionId AND r.article_id=@ArticleId AND r.revision_no=@RevisionNo;
            """, RequireBulkDraftTransaction(transaction), transaction))
        {
            budget.Parameters.AddWithValue("RevisionId", article.RevisionId);
            budget.Parameters.AddWithValue("ArticleId", article.Id);
            budget.Parameters.AddWithValue("RevisionNo", article.RevisionNo);
            object? bytes = await budget.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            RequireBulkDraftTransaction(transaction);
            if (bytes is not long count || count < 0 || count > BulkDraftByteLimit - state._packageBytes)
                throw BulkDraftFailure("revision_package_budget");
            state._packageBytes += count;
        }
        RequireBulkDraftTransaction(transaction);
        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(row => row.Id == article.RevisionId && row.ArticleId == article.Id && row.RevisionNo == article.RevisionNo)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        RequireBulkDraftTransaction(transaction);
        if (revision is null || revision.ContentBlockId <= 0)
            throw BulkDraftFailure("revision_package_missing");
        revision.MarkdownContent = await ArticleRevisionContentBlockStore.LoadAsync(db, revision.ContentBlockId, cancellationToken)
            .ConfigureAwait(false);
        RequireBulkDraftTransaction(transaction);
        return revision;
    }

    private async Task<ArticleRightsSnapshot> ReadBulkRightsAsync(NpgsqlTransaction transaction, LockedArticle article,
        CancellationToken cancellationToken)
    {
        RequireBulkDraftTransaction(transaction);
        ArticleRightsSnapshot? rights = await db.Queryable<ArticleRightsSnapshot>().ClearFilter()
            .Where(row => row.ArticleId == article.Id && row.ArticleRevisionId == article.RevisionId && row.RevisionNo == article.RevisionNo)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        RequireBulkDraftTransaction(transaction);
        return rights ?? throw BulkDraftFailure("rights_package_missing");
    }

    private async Task RequireBulkResponsibilityPreservedAsync(NpgsqlTransaction transaction,
        LockedArticle before, LockedArticle after, CancellationToken cancellationToken)
    {
        RequireBulkDraftTransaction(transaction);
        async Task<ArticleResponsibilitySnapshot?> ReadAsync(LockedArticle article)
        {
            ArticleResponsibilitySnapshot? row = await db.Queryable<ArticleResponsibilitySnapshot>().ClearFilter()
                .Where(item => item.ArticleId == article.Id && item.ArticleRevisionId == article.RevisionId)
                .OrderByDescending(item => item.ResponsibilityVersion).OrderByDescending(item => item.Id)
                .FirstAsync(cancellationToken).ConfigureAwait(false);
            RequireBulkDraftTransaction(transaction);
            if (row is not null && row.RevisionNo != article.RevisionNo)
                throw BulkDraftFailure("responsibility_package_changed");
            return row;
        }
        ArticleResponsibilitySnapshot? left = await ReadAsync(before).ConfigureAwait(false);
        ArticleResponsibilitySnapshot? right = await ReadAsync(after).ConfigureAwait(false);
        if (left is not null && right is not null && before.RevisionId != after.RevisionId && right.PreviousSnapshotId != left.Id)
            throw BulkDraftFailure("responsibility_clone_changed");
        static object? Facts(ArticleResponsibilitySnapshot? row) => row is null ? null : new
        {
            row.InheritSiteAuthor,
            row.AuthorsJson,
            row.ReviewerJson,
            row.SourcesJson,
            row.UpdateSummary,
            row.UpdateReason,
            row.EffectiveAt,
            row.ConclusionImpact,
            row.Methodology,
            row.Applicability,
            row.Limitations,
            row.ResponsiblePersonConfirmed
        };
        if (JsonSerializer.Serialize(Facts(left)) != JsonSerializer.Serialize(Facts(right)))
            throw BulkDraftFailure("responsibility_changed");
    }

    private static bool MatchesBulkCoordinates(LockedArticle article, ArticleLifecycleTransitionWriter.ArticleLifecycleCoordinates coordinates)
        => article.RevisionId == coordinates.RevisionId && article.RevisionNo == coordinates.RevisionNo
            && article.Status == coordinates.Status && article.IsDeleted == coordinates.IsDeleted
            && article.ScheduledPublishAt == coordinates.ScheduledPublishAt;

    internal static bool SameBulkDraftContent(ArticleRevision before, ArticleRevision after)
        => before.Title == after.Title && before.Summary == after.Summary && before.CoverImageUrl == after.CoverImageUrl
            && before.CategoryId == after.CategoryId && before.TagIds == after.TagIds && before.MarkdownContent == after.MarkdownContent;

    internal static bool BulkDraftMatchesRevision(ArticleDraft draft, ArticleRevision revision, ArticleStatus status, DateTime? scheduledAt)
        => draft.ArticleId == revision.ArticleId && draft.BaseRevisionId == revision.Id && draft.Status == status
            && draft.ScheduledPublishAt == scheduledAt && draft.Title == revision.Title && draft.Summary == revision.Summary
            && draft.CoverImageUrl == revision.CoverImageUrl && draft.CategoryId == revision.CategoryId
            && draft.TagIds == revision.TagIds && draft.MarkdownContent == revision.MarkdownContent;

    private static ArticleRightsNormalizedModel BulkRightsModel(ArticleRightsSnapshot rights)
        => new(rights.Enabled, rights.LicenseType, rights.CopyrightHolder, rights.CopyrightYear, rights.RightsStatement,
            rights.AttributionTemplate, rights.CopyPolicy, rights.MaxExcerptChars, rights.AllowCodeCopy,
            rights.ShowPublicBadge, rights.ProofBindingEnabled);

    internal static bool BulkDraftRightsMatch(string? json, ArticleRightsSnapshot rights)
    {
        if (json is null)
            return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json, new()
            {
                MaxDepth = 8
            });
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || document.RootElement.EnumerateObject().Select(static field => field.Name).Distinct(StringComparer.Ordinal).Count()
                    != document.RootElement.EnumerateObject().Count())
                return false;
            string[] fields = ["mode", "enabled", "licenseType", "copyrightHolder", "copyrightYear", "rightsStatement",
                "attributionTemplate", "copyPolicy", "maxExcerptChars", "allowCodeCopy", "showPublicBadge", "proofBindingEnabled"];
            if (document.RootElement.EnumerateObject().Count() != fields.Length
                || fields.Any(field => !document.RootElement.TryGetProperty(field, out _)))
                return false;
            ArticleRightsRequest? request = JsonSerializer.Deserialize<ArticleRightsRequest>(json, s_bulkDraftRightsOptions);
            // Site mode needs the actual site-policy producer; no guessed defaults or catch-and-normalize fallback.
            return request?.Mode == "custom" && JsonSerializer.Serialize(request, s_bulkDraftRightsOptions) == json
                && request.LicenseType is not null && request.CopyPolicy is not null
                && new ArticleRightsNormalizedModel(request.Enabled, request.LicenseType, request.CopyrightHolder,
                    request.CopyrightYear, request.RightsStatement, request.AttributionTemplate, request.CopyPolicy,
                    request.MaxExcerptChars, request.AllowCodeCopy, request.ShowPublicBadge, request.ProofBindingEnabled) == BulkRightsModel(rights);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    internal static void ValidateBulkDraftBinding(ArticleBulkExecutionRequest request, ArticleBulkPlan plan,
        ArticleBulkPlanAuthority plans, ImmutableArray<ArticleBulkPlanItem> items)
    {
        if (items.Length > BulkDraftLimit || items.Any(static item => item.Status != ArticleBulkPlanItemStatus.Eligible)
            || !long.TryParse(request.Actor.UserId, NumberStyles.None, CultureInfo.InvariantCulture, out long owner) || owner <= 0
            || request.Actor.UserId != owner.ToString(CultureInfo.InvariantCulture)
            || items.Any(item => !int.TryParse(item.ArticleId, NumberStyles.None, CultureInfo.InvariantCulture, out int id) || id <= 0
                || item.ArticleId != id.ToString(CultureInfo.InvariantCulture)))
            throw BulkDraftFailure("binding_invalid");
        string?[] text = [request.AttemptId, request.IdempotencyKey, request.PlanReference, request.PlanDigest,
            request.RegistryDigest, request.OperationId, request.ParametersDigest, request.FrozenSetDigest,
            request.ConfirmationDigest, request.AdmissionAuthorityReceiptDigest, request.Actor.UserId, request.Actor.SiteId,
            request.Actor.AuthorityDigest, request.Source.Commit, request.Source.BuildDigest, request.PolicyDigest,
            request.PermissionPolicyDigest, request.ExecutionIdentityDigest, request.ContentDigest,
            .. items.SelectMany(static item => new[] { item.ArticleId, item.ExpectedRevision, item.Lifecycle, item.ReasonCode,
                item.PermissionDigest, item.StateDigest, item.ProposedChangeDigest, item.ContentDigest }),
            .. items.SelectMany(static item => item.DependencyDigests)];
        if (text.Any(static value => !BulkDraftLosslessText(value)))
            throw BulkDraftFailure("binding_text_invalid");
        plans.ValidateIntegrity(plan);
        string execution = ArticleBulkDigest.Of(new
        {
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            plan.Strategy,
            plan.ParametersDigest,
            plan.FrozenSetDigest,
            ConfirmationDigest = request.ConfirmationDigest,
            actor = request.Actor,
            source = request.Source,
            policyDigest = request.PolicyDigest,
            permissionPolicyDigest = request.PermissionPolicyDigest
        });
        if (request.Strategy != ArticleBulkExecutionStrategy.AllOrNothing || plan.Strategy != request.Strategy
            || request.PlanDigest != plan.ContentDigest || request.RegistryDigest != plan.RegistryDigest
            || request.OperationId != plan.OperationId || request.ParametersDigest != plan.ParametersDigest
            || request.FrozenSetDigest != plan.FrozenSetDigest || request.Actor != plan.Actor || request.Source != plan.Source
            || request.PolicyDigest != plan.PolicyDigest || request.PermissionPolicyDigest != plan.PermissionPolicyDigest
            || request.ExecutionIdentityDigest != execution
            || request.ContentDigest != ArticleBulkDigest.Of(request with
            {
                ContentDigest = string.Empty
            }))
            throw BulkDraftFailure("binding_changed");
    }

    private async Task RequireBulkWriterRowsAsync(NpgsqlTransaction transaction, string actor,
        ArticleLifecycleTransitionWriter.Result result, CancellationToken cancellationToken)
    {
        if (result.TransitionId != result.Outbox.EventId || result.Outbox.AggregateId != result.ArticleId)
            throw BulkDraftFailure("writer_reference_invalid");
        using var command = new NpgsqlCommand("""
            SELECT count(*) FROM article_mutation_outbox o
            WHERE o.aggregate_type='article' AND o.aggregate_id=@ArticleId AND o.event_id=@EventId
              AND EXISTS (SELECT 1 FROM sys_audit_log a
                WHERE a.chain_id=@ChainId AND a.record_hash=@RecordHash AND a.actor_type='admin'
                  AND a.actor_id=@Actor AND a.target_type='article-canonical-lifecycle' AND a.target_id=@Target);
            """, RequireBulkDraftTransaction(transaction), transaction);
        command.Parameters.AddWithValue("ArticleId", result.ArticleId);
        command.Parameters.AddWithValue("EventId", result.Outbox.EventId);
        command.Parameters.AddWithValue("ChainId", result.AuditChainId);
        command.Parameters.AddWithValue("RecordHash", result.AuditRecordHash);
        command.Parameters.AddWithValue("Actor", actor);
        command.Parameters.AddWithValue("Target", result.ArticleId.ToString(CultureInfo.InvariantCulture));
        object? count = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        RequireBulkDraftTransaction(transaction);
        if (count is not long value || value != 1)
            throw BulkDraftFailure("writer_rows_missing");
        // Row existence does not validate audit signatures, native commit or required postcommit obligations.
    }

    private static bool BulkDraftLosslessText(string? value)
    {
        if (value is null)
            return true;
        for (int index = 0; index < value.Length; index++)
        {
            if (!char.IsSurrogate(value[index]))
                continue;
            if (!char.IsHighSurrogate(value[index]) || ++index == value.Length || !char.IsLowSurrogate(value[index]))
                return false;
        }
        return true;
    }

    private static InvalidOperationException BulkDraftFailure(string reason)
        => new($"article_bulk_draft_{reason}");
}
