using System.Data;
using System.Globalization;
using System.Runtime.CompilerServices;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Articles.Bulk;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

public static partial class ArticleLifecycleTransitionWriter
{
    private const string BulkRevisionReferencePrefix = "article-bulk-revision.v1:";
    private static readonly ConditionalWeakTable<BulkRevisionResolution, BulkRevisionResolutionState> s_bulkRevisionResolutions = new();

    /// <summary>Observed original row identity only; no actor, session, site, operation or dependency admission.</summary>
    internal sealed record BulkRevisionFacts(int ArticleId, long RevisionId, int RevisionNo,
        string ArticleRowVersion, string RevisionRowVersion, ArticleStatus Status,
        bool IsDeleted, ArticleStatus? PreviousEditableStatus, long ContentBlockId,
        long? PublicationId, DateTime? ScheduledPublishAt);

    /// <summary>Opaque locked original mapping. Possession does not admit an operation or own the native transaction.</summary>
    internal sealed class BulkRevisionResolution
    {
        internal string Reference
        {
            get;
        }
        internal int ArticleId
        {
            get;
        }
        internal long RevisionId
        {
            get;
        }

        internal BulkRevisionResolution(string reference, int articleId, long revisionId)
        {
            Reference = reference;
            ArticleId = articleId;
            RevisionId = revisionId;
        }
    }

    private sealed class BulkRevisionResolutionState(ISqlSugarClient db, NpgsqlTransaction transaction, BulkRevisionFacts facts)
    {
        internal readonly ISqlSugarClient _db = db;
        internal readonly NpgsqlTransaction _transaction = transaction;
        internal readonly BulkRevisionFacts _facts = facts;
        internal int _useState;
    }

    /// <summary>
    /// Produces a bounded opaque reference from actual native article/revision/provenance rows.
    /// Caller owns the original scope and independently admits all access and operation facts.
    /// </summary>
    internal static async Task<string> CaptureBulkRevisionReferenceAsync(ISqlSugarClient db,
        NpgsqlTransaction originalTransaction, int articleId, CancellationToken cancellationToken)
    {
        BulkRevisionFacts facts = await ReadBulkRevisionFactsAsync(db, originalTransaction, articleId,
            lockRows: false, cancellationToken).ConfigureAwait(false);
        RequireBulkRevisionTransaction(db, originalTransaction);
        cancellationToken.ThrowIfCancellationRequested();
        return ComputeBulkRevisionReference(facts);
    }

    /// <summary>
    /// Locks actual original rows and resolves the exact frozen reference by reobservation.
    /// Numeric ExpectedRevision parsing, caller-declared revision IDs and projection references are rejected.
    /// </summary>
    internal static async Task<BulkRevisionResolution> ResolveBulkRevisionReferenceAfterLockAsync(
        ISqlSugarClient db, NpgsqlTransaction originalTransaction, int articleId,
        string expectedReference, CancellationToken cancellationToken)
    {
        RequireBulkRevisionReferenceShape(expectedReference);
        BulkRevisionFacts facts = await ReadBulkRevisionFactsAsync(db, originalTransaction, articleId,
            lockRows: true, cancellationToken).ConfigureAwait(false);
        RequireBulkRevisionTransaction(db, originalTransaction);
        cancellationToken.ThrowIfCancellationRequested();
        string actual = ComputeBulkRevisionReference(facts);
        if (!string.Equals(actual, expectedReference, StringComparison.Ordinal))
            throw BulkRevisionFailure("reference_changed");
        var resolution = new BulkRevisionResolution(actual, facts.ArticleId, facts.RevisionId);
        s_bulkRevisionResolutions.Add(resolution, new(db, originalTransaction, facts));
        return resolution;
    }

    /// <summary>
    /// Consumes this exact original locked resolution once, rechecks actual facts in its original
    /// native scope, then invokes the existing c190 preparation for genuine single-article checks.
    /// The original operation, actor and semantic role remain caller inputs, never grants from this token.
    /// </summary>
    internal static async Task<EditableTransitionPreparation> PrepareEditableTransitionFromBulkRevisionAsync(
        ISqlSugarClient db, NpgsqlTransaction originalTransaction, BulkRevisionResolution resolution,
        long adminPrincipalId, DateTime transitionedAt, string semanticRole,
        ArticleStatusTransitionOperation operation, CancellationToken cancellationToken)
    {
        if (!s_bulkRevisionResolutions.TryGetValue(resolution, out BulkRevisionResolutionState? state)
            || !ReferenceEquals(state._db, db) || !ReferenceEquals(state._transaction, originalTransaction)
            || Interlocked.CompareExchange(ref state._useState, 1, 0) != 0)
            throw BulkRevisionFailure("resolution_unavailable");
        try
        {
            RequireBulkRevisionTransaction(db, originalTransaction);
            BulkRevisionFacts observed = await ReadBulkRevisionFactsAsync(db, originalTransaction, resolution.ArticleId,
                lockRows: true, cancellationToken).ConfigureAwait(false);
            if (observed != state._facts || ComputeBulkRevisionReference(observed) != resolution.Reference
                || observed.RevisionId != resolution.RevisionId)
                throw BulkRevisionFailure("resolution_changed");
            RequireBulkRevisionTransaction(db, originalTransaction);
            EditableTransitionPreparation prepared = await PrepareEditableTransitionAsync(db,
                new(resolution.ArticleId, observed.RevisionId, transitionedAt, adminPrincipalId, semanticRole),
                operation, cancellationToken).ConfigureAwait(false);
            RequireBulkRevisionTransaction(db, originalTransaction);
            cancellationToken.ThrowIfCancellationRequested();
            if (prepared.ArticleId != observed.ArticleId || prepared.ExpectedRevisionId != observed.RevisionId
                || prepared.Before.RevisionNo != observed.RevisionNo || prepared.Before.Status != observed.Status
                || prepared.Before.IsDeleted != observed.IsDeleted
                || prepared.Before.PreviousEditableStatus != observed.PreviousEditableStatus)
                throw BulkRevisionFailure("preparation_changed");
            BulkRevisionFacts afterPreparation = await ReadBulkRevisionFactsAsync(db, originalTransaction, resolution.ArticleId,
                lockRows: true, cancellationToken).ConfigureAwait(false);
            RequireBulkRevisionTransaction(db, originalTransaction);
            if (afterPreparation != observed)
                throw BulkRevisionFailure("preparation_reference_changed");
            cancellationToken.ThrowIfCancellationRequested();
            state._useState = 2;
            return prepared;
        }
        catch
        {
            state._useState = 3;
            throw;
        }
    }

    internal static string ComputeBulkRevisionReference(BulkRevisionFacts facts)
    {
        if (facts.ArticleId <= 0 || facts.RevisionId <= 0 || facts.RevisionNo <= 0 || facts.ContentBlockId <= 0
            || !IsBulkRowVersion(facts.ArticleRowVersion) || !IsBulkRowVersion(facts.RevisionRowVersion))
            throw BulkRevisionFailure("facts_invalid");
        _ = ArticleStatusValues.Token((int)facts.Status);
        if (facts.PreviousEditableStatus.HasValue)
            _ = ArticleStatusValues.Token((int)facts.PreviousEditableStatus.Value);
        return BulkRevisionReferencePrefix + ArticleBulkDigest.Of(new
        {
            Schema = "fsusblog.article-bulk.revision-row-reference.v1",
            Writer = WriterContract,
            facts
        });
    }

    internal static void RequireBulkRevisionReferenceShape(string? reference)
    {
        string prefix = BulkRevisionReferencePrefix + "sha256:";
        if (reference is null || reference.Length != prefix.Length + 64 || !reference.StartsWith(prefix, StringComparison.Ordinal)
            || reference[prefix.Length..].Any(static c => c is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            throw BulkRevisionFailure("reference_invalid");
    }

    private static bool IsBulkRowVersion(string? value)
        => value is not null && uint.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out uint version)
            && value == version.ToString(CultureInfo.InvariantCulture);

    private static NpgsqlConnection RequireBulkRevisionTransaction(ISqlSugarClient db, NpgsqlTransaction transaction)
    {
        if (!ReferenceEquals(db.Ado.Transaction, transaction) || db.Ado.Connection is not NpgsqlConnection connection
            || !ReferenceEquals(transaction.Connection, connection) || connection.State != ConnectionState.Open)
            throw BulkRevisionFailure("original_native_transaction_required");
        return connection;
    }

    private static async Task<BulkRevisionFacts> ReadBulkRevisionFactsAsync(ISqlSugarClient db,
        NpgsqlTransaction transaction, int articleId, bool lockRows, CancellationToken cancellationToken)
    {
        if (articleId <= 0)
            throw BulkRevisionFailure("article_invalid");
        using var command = new NpgsqlCommand("""
            SELECT a.id,a.current_revision_id,r.revision_no,a.xmin::text,r.xmin::text,
                   a.status,a.isdeleted,a.previous_editable_status,r.content_block_id,
                   a.current_publication_id,a.scheduled_publish_at
            FROM article a JOIN article_revision r ON r.id=a.current_revision_id AND r.article_id=a.id
            WHERE a.id=@ArticleId
            """ + (lockRows ? " FOR UPDATE OF a FOR SHARE OF r;" : ";"), RequireBulkRevisionTransaction(db, transaction), transaction);
        command.Parameters.AddWithValue("ArticleId", articleId);
        using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            throw BulkRevisionFailure("article_revision_missing");
        RequireBulkRevisionTransaction(db, transaction);
        var facts = new BulkRevisionFacts(reader.GetInt32(0), reader.GetInt64(1), reader.GetInt32(2),
            reader.GetString(3), reader.GetString(4), (ArticleStatus)reader.GetInt32(5), reader.GetBoolean(6),
            reader.IsDBNull(7) ? null : (ArticleStatus)reader.GetInt32(7), reader.GetInt64(8),
            reader.IsDBNull(9) ? null : reader.GetInt64(9),
            reader.IsDBNull(10) ? null : DateTime.SpecifyKind(reader.GetDateTime(10), DateTimeKind.Unspecified));
        if (facts.ArticleId != articleId || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            throw BulkRevisionFailure("article_revision_ambiguous");
        RequireBulkRevisionTransaction(db, transaction);
        cancellationToken.ThrowIfCancellationRequested();
        return facts;
    }

    private static ArticleWriteValidationException BulkRevisionFailure(string reason)
        => new($"article_bulk_revision_{reason}", "Original bulk revision reference is unavailable or changed.");
}
